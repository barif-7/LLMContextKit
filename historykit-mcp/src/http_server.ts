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
  return false
}

function setCorsHeaders(
  res: http.ServerResponse,
  req: http.IncomingMessage
): void {
  const origin = req.headers.origin
  if (
    origin &&
    typeof origin === 'string' &&
    origin.startsWith('chrome-extension://')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin)
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

        const importResult = upsertConversations(db, conversations)
        process.stderr.write(
          `[historykit-http] imported ${importResult.new_count} new, ` +
            `${importResult.updated_count} updated, ` +
            `${importResult.skipped_count} skipped, ` +
            `${importResult.errored_count} errored ` +
            `(${importResult.message_count} messages)\n`
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

main().catch((err) => {
  process.stderr.write(`[historykit-http] fatal: ${err.message}\n`)
  process.exit(1)
})
