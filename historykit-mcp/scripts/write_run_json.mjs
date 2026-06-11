// Composes ${TELEMETRY_DIR}/run.json from the fetch-hook output (embed-calls.json),
// DB state, and machine/config info. Run after the instrumented backfill completes:
//   TELEMETRY_DIR=telemetry/run-<...> node scripts/write_run_json.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { resolveDbPath } from '../dist/dbPath.js'
import { getEmbeddingConfig } from '../dist/vec.js'

const dir = process.env.TELEMETRY_DIR
if (!dir) { console.error('TELEMETRY_DIR not set'); process.exit(1) }

const calls = JSON.parse(fs.readFileSync(path.join(dir, 'embed-calls.json'), 'utf8'))
const config = getEmbeddingConfig()
const db = new Database(resolveDbPath(), { readonly: true })

let gitSha = 'unknown'
try { gitSha = execSync('git rev-parse --short HEAD', { cwd: path.dirname(fileURLToPath(import.meta.url)) }).toString().trim() } catch {}

const totalMessages = db.prepare('SELECT COUNT(*) n FROM messages').get().n
const eligible = db.prepare(`
  SELECT COUNT(*) n FROM messages m
  WHERE m.text IS NOT NULL AND length(trim(m.text)) >= 20 AND m.role NOT IN ('tool','tool_result')
`).get().n
const embedded = db.prepare(
  'SELECT COUNT(*) n FROM message_embeddings WHERE embedding_model = ? AND embedding_dim = ?'
).get(config.model, config.dims).n

const run = {
  config: {
    model: config.model,
    dimension: config.dims,
    vector_table: config.vectorTable,
    max_content_chars: config.maxContentChars,
    ollama_endpoint: process.env.OLLAMA_EMBEDDINGS_URL ?? 'http://127.0.0.1:11434/api/embeddings',
    node_version: process.version,
    machine: { hostname: os.hostname(), arch: os.arch(), platform: os.platform(), cpus: os.cpus()[0]?.model },
    git_sha: gitSha,
    started_at: calls.started_at,
    ended_at: calls.ended_at,
  },
  corpus: {
    total_messages: totalMessages,
    eligible_candidates: eligible,
    skipped_noise_filter: totalMessages - eligible,
    skipped_reason: "text < 20 chars after trim, or role in ('tool','tool_result')",
    embedded,
    failed_messages: eligible - embedded,
    failed_embed_calls: calls.failures_count,
    failed_embed_calls_note: 'per-call failures (e.g. context-overflow HTTP 500s) that were retried at smaller char counts; a message only counts as failed if it never embedded',
    failure_sample: calls.failures_sample,
  },
  throughput: {
    wall_clock_seconds: calls.wall_clock_seconds,
    messages_per_sec: Number((embedded / calls.wall_clock_seconds).toFixed(2)),
    chars_per_sec: calls.chars_per_sec,
    embed_calls_total_ok: calls.embed_calls_ok,
    note: 'embed calls > embedded messages when context-overflow retries occur; chars_per_sec counts chars actually sent to Ollama (the fairer cross-model metric)',
  },
  embed_call_latency_ms: calls.latency_ms,
  batch: { concurrency: 1, db_commit_batch_size: 50 },
  peak_rss_bytes: calls.peak_rss_bytes,
  code_changes_for_this_run: 'none — telemetry captured via a fetch-wrapping preload hook (scripts/telemetry_fetch_hook.mjs); production embed/index code untouched',
}

fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2))
console.log(`run.json written: ${embedded}/${eligible} embedded in ${calls.wall_clock_seconds}s (${run.throughput.messages_per_sec} msgs/sec, ${calls.chars_per_sec} chars/sec)`)
db.close()
