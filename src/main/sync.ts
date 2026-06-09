import { app, ipcMain } from 'electron'
import Store from 'electron-store'
import { spawn } from 'child_process'
import fs from 'fs'
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
    String(Number(process.env.HISTORYKIT_CHROME_DEBUG_PORT || 9222)),
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
  ipcMain.handle('sync:run', async (_event, mode: SyncMode) => {
    return await runSync(mode)
  })
}
