import { app, ipcMain } from 'electron'
import Store from 'electron-store'
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import path from 'path'

export type SyncMode = 'chatgpt-extension' | 'chatgpt-native' | 'claude-native'

export interface SyncFlags {
  browserExtensionChatGPT: boolean
  nativeChatGPT: boolean
  nativeClaude: boolean
}

export interface SyncRunResult {
  ok: boolean
  mode: SyncMode
  message?: string
  listeners?: number
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: string
}

export interface ChatGPTAuthStatus {
  debugPort: number
  chromeReachable: boolean
  hasChatGPTTarget: boolean
  authenticated: boolean
  title?: string
  url?: string
  message: string
}

const store = new Store<{ syncFlags: SyncFlags }>({
  name: 'historykit-settings',
})

const DEFAULT_FLAGS: SyncFlags = {
  browserExtensionChatGPT: true,
  nativeChatGPT: false,
  nativeClaude: false,
}

let activeRun: { mode: SyncMode; startedAt: number } | null = null

function getFlags(): SyncFlags {
  return {
    ...DEFAULT_FLAGS,
    ...(store.get('syncFlags') || {}),
  }
}

function setFlags(patch: Partial<SyncFlags>): SyncFlags {
  const next = {
    ...getFlags(),
    ...patch,
  }
  store.set('syncFlags', next)
  return next
}

function historykitHttpUrl() {
  return 'http://127.0.0.1:8765'
}

function chromeDebugPort() {
  return Number(process.env.HISTORYKIT_CHROME_DEBUG_PORT || 9222)
}

function chromeDebugProfilePath() {
  return process.env.HISTORYKIT_CHROME_PROFILE
    || path.join(app.getPath('userData'), 'chrome-debug')
}

function chromeDebugUrl(pathname: string) {
  return `http://127.0.0.1:${chromeDebugPort()}${pathname}`
}

function nativeSyncScriptPath() {
  const devCandidate = path.join(app.getAppPath(), 'scripts', 'sync-chatgpt-history.mjs')
  const packagedCandidate = path.join(process.resourcesPath, 'scripts', 'sync-chatgpt-history.mjs')
  if (fs.existsSync(devCandidate)) return devCandidate
  if (fs.existsSync(packagedCandidate)) return packagedCandidate
  return devCandidate
}

async function triggerExtensionSync(): Promise<SyncRunResult> {
  const res = await fetch(`${historykitHttpUrl()}/trigger-sync`, {
    method: 'POST',
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Extension trigger failed: HTTP ${res.status}`)
  }
  return {
    ok: true,
    mode: 'chatgpt-extension',
    listeners: Number(data.listeners || 0),
    message: data.listeners
      ? `Triggered extension sync (${data.listeners} listener${data.listeners === 1 ? '' : 's'})`
      : 'Triggered extension sync, but no extension listener was connected',
  }
}

async function runNativeChatGPTSync(): Promise<SyncRunResult> {
  const scriptPath = nativeSyncScriptPath()
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Native sync script not found: ${scriptPath}`)
  }

  const nodeBin = process.env.HISTORYKIT_NODE_BIN || 'node'
  const args = [
    scriptPath,
    '--debug-port',
    String(chromeDebugPort()),
    '--import-url',
    historykitHttpUrl(),
  ]

  return await new Promise<SyncRunResult>((resolve, reject) => {
    const child = spawn(nodeBin, args, {
      cwd: app.getAppPath(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      reject(new Error(`Failed to launch native sync: ${err.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          mode: 'chatgpt-native',
          exitCode: code ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim() || undefined,
          message: 'Native ChatGPT sync completed',
        })
      } else {
        resolve({
          ok: false,
          mode: 'chatgpt-native',
          exitCode: code ?? 1,
          stdout: stdout.trim() || undefined,
          stderr: stderr.trim() || undefined,
          error: stderr.trim() || stdout.trim() || `Native sync exited with code ${code}`,
        })
      }
    })
  })
}

function requestText(url: string, init: { method?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method || 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`HTTP ${res.statusCode || 0} for ${url}${body ? `: ${body}` : ''}`))
          return
        }
        resolve(body)
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => {
      req.destroy(new Error(`Timed out connecting to ${url}`))
    })
    req.end()
  })
}

async function requestJson<T>(url: string, init?: { method?: string }): Promise<T> {
  return JSON.parse(await requestText(url, init)) as T
}

async function chromeTargets(): Promise<any[]> {
  const targets = await requestJson<any[]>(chromeDebugUrl('/json/list'))
  return Array.isArray(targets) ? targets : []
}

function pickChatGPTTarget(targets: any[]) {
  const pageTargets = targets.filter((target) => target?.type === 'page' && target?.webSocketDebuggerUrl)
  return pageTargets
    .map((target) => {
      const url = String(target.url || '')
      const title = String(target.title || '')
      let score = 0
      if (url.includes('chatgpt.com')) score += 10
      if (url.includes('chat.openai.com')) score += 8
      if (title.toLowerCase().includes('chatgpt')) score += 4
      if (url === 'https://chatgpt.com/' || url.startsWith('https://chatgpt.com/?')) score += 4
      return { target, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.target ?? null
}

async function connectDebugger(webSocketDebuggerUrl: string) {
  const socket = await openRawWebSocket(webSocketDebuggerUrl)

  let nextId = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>()

  socket.onMessage((raw) => {
    const message = JSON.parse(raw)
    if (message.id == null) return
    const record = pending.get(message.id)
    if (!record) return
    pending.delete(message.id)
    if (message.error) {
      record.reject(new Error(message.error.message || 'Chrome DevTools Protocol error'))
    } else {
      record.resolve(message.result ?? {})
    }
  })

  const send = (method: string, params: Record<string, any> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  const close = async () => {
    for (const { reject } of pending.values()) reject(new Error('Debugger closed'))
    pending.clear()
    socket.close()
  }

  return { send, close }
}

async function openRawWebSocket(webSocketDebuggerUrl: string) {
  const wsUrl = new URL(webSocketDebuggerUrl)
  const host = wsUrl.hostname
  const port = Number(wsUrl.port || 80)
  const requestPath = `${wsUrl.pathname}${wsUrl.search}`
  const key = crypto.randomBytes(16).toString('base64')
  const socket = net.createConnection({ host, port })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'))
    })

    let handshake = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk])
      const headerEnd = handshake.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      socket.off('error', onError)
      socket.off('data', onData)
      const header = handshake.slice(0, headerEnd).toString('utf8')
      if (!header.startsWith('HTTP/1.1 101')) {
        reject(new Error(`Chrome DevTools websocket handshake failed: ${header.split('\r\n')[0]}`))
        return
      }
      const rest = handshake.slice(headerEnd + 4)
      if (rest.length) socket.unshift(rest)
      resolve()
    }
    socket.on('data', onData)
  })

  const listeners = new Set<(message: string) => void>()
  let frameBuffer = Buffer.alloc(0)

  socket.on('data', (chunk) => {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    frameBuffer = Buffer.concat([frameBuffer, chunkBuffer])
    while (frameBuffer.length >= 2) {
      const first = frameBuffer[0]
      const second = frameBuffer[1]
      const opcode = first & 0x0f
      const masked = Boolean(second & 0x80)
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (frameBuffer.length < offset + 2) return
        length = frameBuffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (frameBuffer.length < offset + 8) return
        const high = frameBuffer.readUInt32BE(offset)
        const low = frameBuffer.readUInt32BE(offset + 4)
        length = high * 2 ** 32 + low
        offset += 8
      }
      const mask = masked ? frameBuffer.slice(offset, offset + 4) : null
      if (masked) offset += 4
      if (frameBuffer.length < offset + length) return
      let payload = frameBuffer.slice(offset, offset + length)
      frameBuffer = frameBuffer.slice(offset + length)

      if (mask) {
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
      }
      if (opcode === 1) {
        const text = payload.toString('utf8')
        listeners.forEach((listener) => listener(text))
      } else if (opcode === 8) {
        socket.end()
      } else if (opcode === 9) {
        sendFrame(socket, payload, 10)
      }
    }
  })

  return {
    onMessage(listener: (message: string) => void) {
      listeners.add(listener)
    },
    send(message: string) {
      sendFrame(socket, Buffer.from(message, 'utf8'), 1)
    },
    close() {
      sendFrame(socket, Buffer.alloc(0), 8)
      socket.end()
    },
  }
}

function sendFrame(socket: net.Socket, payload: Buffer, opcode: number) {
  const mask = crypto.randomBytes(4)
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | payload.length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(payload.length, 6)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
  socket.write(Buffer.concat([header, mask, masked]))
}

async function pageEvaluate(send: (method: string, params?: Record<string, any>) => Promise<any>, fn: () => Promise<any>) {
  const result = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })

  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Page evaluation failed'
    throw new Error(message)
  }

  return result.result?.value
}

async function openChatGPTDebugTab() {
  await requestJson(chromeDebugUrl(`/json/new?${encodeURIComponent('https://chatgpt.com')}`), { method: 'PUT' })
}

async function launchChromeDebug(): Promise<SyncRunResult> {
  fs.mkdirSync(chromeDebugProfilePath(), { recursive: true })
  const port = chromeDebugPort()

  let reachable = false
  try {
    await chromeTargets()
    reachable = true
  } catch {
    reachable = false
  }

  if (!reachable) {
    if (process.platform === 'darwin') {
      const args = [
        '-na',
        'Google Chrome',
        '--args',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${chromeDebugProfilePath()}`,
        'https://chatgpt.com',
      ]
      const child = spawn('open', args, {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } else {
      const chromeBin = process.platform === 'win32' ? 'chrome.exe' : 'google-chrome'
      const child = spawn(chromeBin, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${chromeDebugProfilePath()}`,
        'https://chatgpt.com',
      ], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    }
  } else {
    const targets = await chromeTargets()
    if (!pickChatGPTTarget(targets)) {
      await openChatGPTDebugTab().catch(() => {})
    }
  }

  return {
    ok: true,
    mode: 'chatgpt-native',
    message: `Opened ChatGPT debug Chrome on port ${port}`,
  }
}

async function chatGPTAuthStatus(): Promise<ChatGPTAuthStatus> {
  const port = chromeDebugPort()
  let targets: any[]
  try {
    targets = await chromeTargets()
  } catch (err: any) {
    return {
      debugPort: port,
      chromeReachable: false,
      hasChatGPTTarget: false,
      authenticated: false,
      message: `Chrome debug port ${port} is not reachable`,
    }
  }

  const target = pickChatGPTTarget(targets)
  if (!target) {
    return {
      debugPort: port,
      chromeReachable: true,
      hasChatGPTTarget: false,
      authenticated: false,
      message: 'Chrome is open, but no ChatGPT tab is visible yet',
    }
  }

  const statusBase = {
    debugPort: port,
    chromeReachable: true,
    hasChatGPTTarget: true,
    title: String(target.title || ''),
    url: String(target.url || ''),
  }

  const debuggerClient = await connectDebugger(target.webSocketDebuggerUrl)
  try {
    await debuggerClient.send('Runtime.enable')
    const session = await pageEvaluate(debuggerClient.send, async () => {
      const res = await fetch('/api/auth/session', { credentials: 'include' })
      if (!res.ok) return { ok: false, status: res.status }
      const data: any = await res.json()
      return { ok: true, authenticated: Boolean(data?.accessToken || data?.user), user: data?.user?.email || data?.user?.name || null }
    })

    if (session?.authenticated) {
      return {
        ...statusBase,
        authenticated: true,
        message: session.user ? `Signed in as ${session.user}` : 'ChatGPT is authenticated',
      }
    }

    return {
      ...statusBase,
      authenticated: false,
      message: 'ChatGPT is open; finish signing in to continue',
    }
  } catch (err: any) {
    return {
      ...statusBase,
      authenticated: false,
      message: 'Waiting for ChatGPT sign-in to complete',
    }
  } finally {
    await debuggerClient.close().catch(() => {})
  }
}

async function runClaudeNativeSync(): Promise<SyncRunResult> {
  throw new Error('Claude native sync is not implemented yet')
}

async function runSync(mode: SyncMode): Promise<SyncRunResult> {
  const flags = getFlags()
  if (activeRun) {
    throw new Error(`Sync already running: ${activeRun.mode}`)
  }

  if (mode === 'chatgpt-extension' && !flags.browserExtensionChatGPT) {
    throw new Error('Browser extension ChatGPT sync is disabled by feature flag')
  }
  if (mode === 'chatgpt-native' && !flags.nativeChatGPT) {
    throw new Error('Native ChatGPT sync is disabled by feature flag')
  }
  if (mode === 'claude-native' && !flags.nativeClaude) {
    throw new Error('Native Claude sync is disabled by feature flag')
  }

  activeRun = { mode, startedAt: Date.now() }
  try {
    if (mode === 'chatgpt-extension') return await triggerExtensionSync()
    if (mode === 'chatgpt-native') return await runNativeChatGPTSync()
    return await runClaudeNativeSync()
  } finally {
    activeRun = null
  }
}

export function registerSyncIpc() {
  ipcMain.handle('sync:flags:get', async () => getFlags())
  ipcMain.handle('sync:flags:set', async (_event, patch: Partial<SyncFlags>) => setFlags(patch || {}))
  ipcMain.handle('sync:status', async () => ({
    flags: getFlags(),
    activeRun,
  }))
  ipcMain.handle('sync:chatgptAuthStart', async () => {
    return await launchChromeDebug()
  })
  ipcMain.handle('sync:chatgptAuthStatus', async () => {
    return await chatGPTAuthStatus()
  })
  ipcMain.handle('sync:run', async (_event, mode: SyncMode) => {
    return await runSync(mode)
  })
}
