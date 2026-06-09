#!/usr/bin/env node
import http from 'http'
import Database from 'better-sqlite3'
import { resolveDbPath } from './dbPath.js'
import {
  ensureFtsSchema,
  getKnownIds,
  getDbStatus,
  upsertConversations,
} from './importer.js'

const PORT = 8765
const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 50 * 1024 * 1024

let syncResolvers: Array<{
  resolve: (value: { action: string }) => void
  timer: ReturnType<typeof setTimeout>
}> = []

function checkOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (origin === 'null') return true
  if (typeof origin === 'string' && origin.startsWith('chrome-extension://'))
    return true
  if (origin === 'https://chatgpt.com') return true
  return false
}

function setCorsHeaders(
  res: http.ServerResponse,
  req: http.IncomingMessage
): void {
  const origin = req.headers.origin
  const allowPrivateNetwork =
    typeof req.headers['access-control-request-private-network'] === 'string'
      ? req.headers['access-control-request-private-network'] === 'true'
      : true
  if (
    origin &&
    typeof origin === 'string' &&
    (origin.startsWith('chrome-extension://') || origin === 'https://chatgpt.com')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Private-Network', String(allowPrivateNetwork))
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'null')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
}

function json(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

async function main() {
  const dbPath = resolveDbPath()
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = normal')
  db.pragma('temp_store = memory')

  ensureFtsSchema(db)
  process.stderr.write(`[historykit-http] connected to ${dbPath}\n`)

  const server = http.createServer(async (req, res) => {
    if (!checkOrigin(req)) {
      json(res, 403, { error: 'Forbidden origin' })
      return
    }

    setCorsHeaders(res, req)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
    const pathname = url.pathname

    try {
      if (req.method === 'GET' && pathname === '/direct-sync.js') {
        const body = directSyncScript()
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        })
        res.end(body)
        return
      }

      if (req.method === 'GET' && pathname === '/health') {
        json(res, 200, { status: 'ok' })
        return
      }

      if (req.method === 'GET' && pathname === '/status') {
        json(res, 200, getDbStatus(db))
        return
      }

      if (req.method === 'GET' && pathname === '/known-ids') {
        json(res, 200, getKnownIds(db))
        return
      }

      if (req.method === 'POST' && pathname === '/import') {
        const body = await readBody(req)
        let payload: any
        try {
          payload = JSON.parse(body)
        } catch {
          json(res, 400, { error: 'Invalid JSON' })
          return
        }

        const conversations: any[] | null = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.conversations)
            ? payload.conversations
            : null

        if (!conversations) {
          json(res, 400, {
            error: 'Expected array of conversations or { conversations: [...] }',
          })
          return
        }

        const importResult = upsertConversations(db, conversations, {
          force: Boolean(payload?.force),
        })
        process.stderr.write(
          `[historykit-http] imported ${importResult.new_count} new, ` +
            `${importResult.updated_count} updated, ` +
            `${importResult.skipped_count} skipped, ` +
            `${importResult.errored_count} errored ` +
            `(${importResult.message_count} messages, ` +
            `${importResult.code_block_count} code blocks, ` +
            `${importResult.attachment_count} attachments, ` +
            `${importResult.file_content_count} file contents, ` +
            `${importResult.link_count} links, ` +
            `${importResult.memory_count} memories)\n`
        )
        json(res, 200, importResult)
        return
      }

      if (req.method === 'POST' && pathname === '/trigger-sync') {
        const pending = syncResolvers.splice(0)
        for (const { resolve, timer } of pending) {
          clearTimeout(timer)
          resolve({ action: 'sync' })
        }
        json(res, 200, { triggered: true, listeners: pending.length })
        return
      }

      if (req.method === 'GET' && pathname === '/sync-instruction') {
        const timeout = 30_000
        const instruction = await new Promise<{ action: string }>((resolve) => {
          const timer = setTimeout(() => {
            const idx = syncResolvers.findIndex((r) => r.resolve === resolve)
            if (idx !== -1) syncResolvers.splice(idx, 1)
            resolve({ action: 'none' })
          }, timeout)
          syncResolvers.push({ resolve, timer })
        })
        json(res, 200, instruction)
        return
      }

      json(res, 404, { error: 'Not found' })
    } catch (err: any) {
      process.stderr.write(
        `[historykit-http] error: ${err.stack ?? err.message}\n`
      )
      json(res, 500, { error: err.message })
    }
  })

  server.listen(PORT, HOST, () => {
    process.stderr.write(
      `[historykit-http] listening on http://${HOST}:${PORT}\n`
    )
  })

  const shutdown = () => {
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function directSyncScript(): string {
  return String.raw`
(() => {
  if (window.__historykitDirectSyncRunning) {
    console.log('[historykit-direct] sync already running')
    return
  }
  window.__historykitDirectSyncRunning = true

  const HISTORYKIT_URL = 'http://127.0.0.1:8765'
  const BATCH_SIZE = 3
  const DELAY_MS = 800
  const PAGE_LIMIT = 100
  const MAX_RETRIES = 5
  const BASE_BACKOFF = 2000
  const POST_BATCH_SIZE = 25

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const progress = (text) => {
    console.log('[historykit-direct]', text)
    document.title = 'HistoryKit: ' + text
  }

  async function getAccessToken() {
    const res = await fetch('/api/auth/session')
    if (!res.ok) throw new Error('Auth session failed: ' + res.status)
    const data = await res.json()
    if (!data.accessToken) throw new Error('Not logged in to ChatGPT')
    return data.accessToken
  }

  async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, options)
        if (res.status === 429) {
          await sleep(BASE_BACKOFF * Math.pow(2, attempt))
          continue
        }
        if (res.status === 403) throw new Error('Session expired; log in to ChatGPT')
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText)
        return res
      } catch (err) {
        if (attempt === retries || String(err.message).includes('Session expired')) throw err
        await sleep(BASE_BACKOFF * Math.pow(2, attempt))
      }
    }
    throw new Error('Exhausted retries')
  }

  async function main() {
    try {
      progress('auth')
      const token = await getAccessToken()
      const headers = { Authorization: 'Bearer ' + token }

      progress('known ids')
      const knownIds = await fetch(HISTORYKIT_URL + '/known-ids').then((res) => res.json())

      progress('listing conversations')
      const allConvSummaries = []
      let offset = 0
      let total = Infinity
      while (offset < total) {
        const res = await fetchWithRetry(
          'https://chatgpt.com/backend-api/conversations?offset=' + offset + '&limit=' + PAGE_LIMIT + '&order=updated',
          { headers }
        )
        const data = await res.json()
        total = data.total ?? data.items?.length ?? 0
        const items = data.items ?? []
        allConvSummaries.push(...items)
        offset += items.length
        if (items.length === 0) break
        progress('listed ' + allConvSummaries.length + '/' + total)
        await sleep(DELAY_MS)
      }

      const needsFetch = allConvSummaries.filter((conv) => {
        const localTime = knownIds[conv.id]
        if (localTime == null) return true
        if (conv.update_time == null) return true
        return conv.update_time > localTime
      })
      progress('fetching ' + needsFetch.length + ' changed conversations')

      const fullConversations = []
      let fetchErrors = 0
      for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
        const batch = needsFetch.slice(i, i + BATCH_SIZE)
        const results = await Promise.all(batch.map(async (conv) => {
          try {
            const res = await fetchWithRetry('https://chatgpt.com/backend-api/conversation/' + conv.id, { headers })
            return await res.json()
          } catch (err) {
            console.error('[historykit-direct] failed to fetch ' + conv.id, err)
            fetchErrors++
            return null
          }
        }))
        fullConversations.push(...results.filter(Boolean))
        progress('fetched ' + Math.min(i + BATCH_SIZE, needsFetch.length) + '/' + needsFetch.length)
        if (i + BATCH_SIZE < needsFetch.length) await sleep(DELAY_MS)
      }

      let totalNew = 0
      let totalUpdated = 0
      let totalSkipped = allConvSummaries.length - needsFetch.length
      let totalErrored = fetchErrors
      let totalMessages = 0
      let totalCodeBlocks = 0
      let totalAttachments = 0
      let totalFileContents = 0
      let totalLinks = 0
      let totalMemories = 0
      for (let i = 0; i < fullConversations.length; i += POST_BATCH_SIZE) {
        const batch = fullConversations.slice(i, i + POST_BATCH_SIZE)
        progress('importing ' + Math.min(i + POST_BATCH_SIZE, fullConversations.length) + '/' + fullConversations.length)
        const result = await fetch(HISTORYKIT_URL + '/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversations: batch }),
        }).then((res) => res.json())
        totalNew += result.new_count ?? 0
        totalUpdated += result.updated_count ?? 0
        totalSkipped += result.skipped_count ?? 0
        totalErrored += result.errored_count ?? 0
        totalMessages += result.message_count ?? 0
        totalCodeBlocks += result.code_block_count ?? 0
        totalAttachments += result.attachment_count ?? 0
        totalFileContents += result.file_content_count ?? 0
        totalLinks += result.link_count ?? 0
        totalMemories += result.memory_count ?? 0
      }

      const summary = {
        new: totalNew,
        updated: totalUpdated,
        skipped: totalSkipped,
        errors: totalErrored,
        total: allConvSummaries.length,
        messages: totalMessages,
        code_blocks: totalCodeBlocks,
        attachments: totalAttachments,
        file_contents: totalFileContents,
        links: totalLinks,
        memories: totalMemories,
      }
      localStorage.setItem('historykit_direct_sync_result', JSON.stringify({ at: new Date().toISOString(), summary }))
      progress('done ' + JSON.stringify(summary))
      window.__historykitDirectSyncRunning = false
    } catch (err) {
      window.__historykitDirectSyncRunning = false
      localStorage.setItem('historykit_direct_sync_error', JSON.stringify({ at: new Date().toISOString(), error: err.message }))
      progress('error: ' + err.message)
      console.error('[historykit-direct] sync failed', err)
    }
  }

  main()
})()
`
}

main().catch((err) => {
  process.stderr.write(`[historykit-http] fatal: ${err.message}\n`)
  process.exit(1)
})
