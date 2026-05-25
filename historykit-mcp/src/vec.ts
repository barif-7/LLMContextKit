import type Database from 'better-sqlite3'
import { load as loadSqliteVecExtension } from 'sqlite-vec'

const OLLAMA_EMBEDDINGS_URL = process.env.OLLAMA_EMBEDDINGS_URL ?? 'http://127.0.0.1:11434/api/embeddings'
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text'
export const DEFAULT_EMBED_DIMS = 768
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL
const OLLAMA_EMBED_DIMS = Number(process.env.OLLAMA_EMBED_DIMS ?? DEFAULT_EMBED_DIMS)

export type EmbeddingConfig = {
  model: string
  dims: number
  vectorTable: string
  maxContentChars: number
}

function safeIdentifierPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
}

export function getEmbeddingConfig(): EmbeddingConfig {
  if (!Number.isInteger(OLLAMA_EMBED_DIMS) || OLLAMA_EMBED_DIMS < 1) {
    throw new Error('OLLAMA_EMBED_DIMS must be a positive integer')
  }

  const maxContentChars = Number(process.env.OLLAMA_EMBED_CONTEXT_CHARS ?? 8000)
  if (!Number.isInteger(maxContentChars) || maxContentChars < 20) {
    throw new Error('OLLAMA_EMBED_CONTEXT_CHARS must be an integer >= 20')
  }

  const isDefault = OLLAMA_EMBED_MODEL === DEFAULT_EMBED_MODEL && OLLAMA_EMBED_DIMS === DEFAULT_EMBED_DIMS
  return {
    model: OLLAMA_EMBED_MODEL,
    dims: OLLAMA_EMBED_DIMS,
    vectorTable: isDefault
      ? 'message_vectors'
      : `message_vectors_${safeIdentifierPart(OLLAMA_EMBED_MODEL)}_${OLLAMA_EMBED_DIMS}`,
    maxContentChars,
  }
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

export function loadVecExtension(db: Database.Database): void {
  loadSqliteVecExtension(db)
}

export function float32Buffer(values: number[]): Float32Array {
  const config = getEmbeddingConfig()
  if (values.length !== config.dims) {
    throw new Error(`Expected ${config.dims}-dimension embedding for ${config.model}, got ${values.length}`)
  }
  return new Float32Array(values)
}

export async function ollamaEmbed(prompt: string): Promise<Float32Array> {
  const response = await fetch(OLLAMA_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: getEmbeddingConfig().model, prompt }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Ollama embeddings request failed (${response.status}): ${body}`)
  }

  const data = await response.json() as { embedding?: number[] }
  if (!Array.isArray(data.embedding)) {
    throw new Error('Ollama embeddings response did not include an embedding array')
  }

  return float32Buffer(data.embedding)
}
