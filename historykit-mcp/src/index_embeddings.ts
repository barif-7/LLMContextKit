#!/usr/bin/env node
/**
 * Build local semantic embeddings for HistoryKit messages using Ollama.
 *
 * Runtime expectation: indexing roughly 11k messages with nomic-embed-text
 * usually takes about 20-40 minutes on a Mac mini CPU. The script is
 * idempotent and resumes from the last successfully indexed message.
 */
import Database from 'better-sqlite3'
import { setTimeout as sleep } from 'timers/promises'
import { resolveDbPath } from './dbPath.js'
import { getEmbeddingConfig, loadVecExtension, ollamaEmbed, quoteIdentifier } from './vec.js'

const BATCH_SIZE = 50
const PROGRESS_EVERY = 500
const CONTEXT_RETRY_CHARS = [6000, 4000, 2500, 1200]
const MIN_CONTENT_CHARS = 20

type PendingMessage = {
  id: string
  conv_id: string
  role: string
  text: string
  create_time: number | null
  source: string
}

function isoDate(ts: number | null): string {
  if (!ts) return '1970-01-01'
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

function isNoise(row: PendingMessage): boolean {
  const text = row.text?.trim() ?? ''
  return text.length < MIN_CONTENT_CHARS || row.role === 'tool' || row.role === 'tool_result'
}

function readLimitArg(): number | null {
  const index = process.argv.indexOf('--limit')
  if (index === -1) return null
  const raw = process.argv[index + 1]
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--limit must be followed by a positive integer')
  }
  return value
}

async function embedWithRetry(messageId: string, text: string): Promise<Float32Array> {
  let lastError: unknown
  let prompt = text
  const contextRetryChars = [...CONTEXT_RETRY_CHARS]
  let transientAttempts = 0

  while (true) {
    try {
      return await ollamaEmbed(prompt)
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const contextRetry = message.toLowerCase().includes('context length') || message.toLowerCase().includes('input length')
      if (contextRetry && contextRetryChars.length > 0) {
        const nextLength = contextRetryChars.shift()
        if (nextLength !== undefined && prompt.length > nextLength) {
          prompt = text.slice(0, nextLength)
          console.warn(`Message ${messageId} exceeded embedding context; retrying with ${nextLength} chars.`)
          continue
        }
      }

      transientAttempts += 1
      if (transientAttempts >= 3) break
      await sleep(500 * 2 ** (transientAttempts - 1))
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Failed to embed message ${messageId} after 3 attempts: ${message}`)
}

async function main() {
  const reset = process.argv.includes('--reset')
  const limit = readLimitArg()
  const config = getEmbeddingConfig()
  const dbPath = resolveDbPath()
  const db = new Database(dbPath, { fileMustExist: true })

  try {
    loadVecExtension(db)
    db.pragma('journal_mode = WAL')

    if (reset) {
      db.exec(`DELETE FROM message_embeddings; DELETE FROM ${quoteIdentifier(config.vectorTable)};`)
      console.log('Cleared existing semantic embedding index.')
    } else {
      const mismatch = db.prepare(`
        SELECT embedding_model, embedding_dim, COUNT(*) as n
        FROM message_embeddings
        WHERE embedding_model != ? OR embedding_dim != ?
        GROUP BY embedding_model, embedding_dim
        LIMIT 1
      `).get(config.model, config.dims) as any
      if (mismatch) {
        throw new Error(
          `Existing semantic index uses ${mismatch.embedding_model} (${mismatch.embedding_dim} dims). ` +
          `Run npm run semantic:rebuild after setting OLLAMA_EMBED_MODEL/OLLAMA_EMBED_DIMS to rebuild for ${config.model} (${config.dims} dims).`
        )
      }
    }

    const pending = db.prepare(`
      SELECT m.id, m.conv_id, m.role, m.text, m.create_time, m.source
      FROM messages m
      LEFT JOIN message_embeddings e ON e.message_id = m.id
      WHERE e.message_id IS NULL
        AND m.text IS NOT NULL
        AND length(trim(m.text)) >= ?
        AND m.role NOT IN ('tool', 'tool_result')
      ORDER BY m.create_time ASC, m.id ASC
    `).all(MIN_CONTENT_CHARS) as PendingMessage[]
    const queue = limit === null ? pending : pending.slice(0, limit)

    console.log(`Found ${pending.length} messages needing embeddings${limit === null ? '' : `; indexing ${queue.length} due to --limit`}.`)
    if (queue.length === 0) return

    const insertMetadata = db.prepare(`
      INSERT INTO message_embeddings
        (message_id, conversation_id, role, date, source, text_preview, embedded_at, embedding_model, embedding_dim)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertVector = db.prepare(`
      INSERT INTO ${quoteIdentifier(config.vectorTable)}(message_id, embedding)
      VALUES (?, ?)
    `)
    const commitChunk = db.transaction((items: Array<{ row: PendingMessage; embedding: Float32Array }>) => {
      const embeddedAt = new Date().toISOString()
      for (const item of items) {
        insertMetadata.run(
          item.row.id,
          item.row.conv_id,
          item.row.role,
          isoDate(item.row.create_time),
          item.row.source,
          item.row.text.slice(0, 500),
          embeddedAt,
          config.model,
          config.dims
        )
        insertVector.run(item.row.id, item.embedding)
      }
    })

    let indexed = 0
    let chunk: Array<{ row: PendingMessage; embedding: Float32Array }> = []

    for (const row of queue) {
      if (isNoise(row)) continue

      const embedding = await embedWithRetry(row.id, row.text.slice(0, config.maxContentChars))
      chunk.push({ row, embedding })

      if (chunk.length >= BATCH_SIZE) {
        commitChunk(chunk)
        indexed += chunk.length
        chunk = []
        if (indexed % PROGRESS_EVERY === 0) {
          console.log(`Indexed ${indexed}/${queue.length} messages...`)
        }
      }
    }

    if (chunk.length > 0) {
      commitChunk(chunk)
      indexed += chunk.length
    }

    console.log(`Indexed ${indexed} messages. Semantic search is ready.`)
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
