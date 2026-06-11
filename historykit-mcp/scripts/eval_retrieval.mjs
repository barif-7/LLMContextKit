// Fixed retrieval-quality probe harness. Re-run after any embedding-model swap and
// diff retrieval-eval.json across runs.
//
// Usage: TELEMETRY_DIR=telemetry/run-<model>-<ts> node scripts/eval_retrieval.mjs
//
// Mirrors the production semantic_search logic in src/tools.ts:
//   - FTS leg: messages_fts MATCH, active branch only, ordered by create_time DESC
//   - vector leg: sqlite-vec KNN over the config vector table (model+dim filtered)
//   - fused: reciprocal rank fusion 1/(60+rank+1), candidate limit k*3 per leg
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { resolveDbPath } from '../dist/dbPath.js'
import { getEmbeddingConfig, loadVecExtension, ollamaEmbed, quoteIdentifier } from '../dist/vec.js'

const K = 5
const CANDIDATE_LIMIT = K * 3

const PROBES = [
  { group: 'prose', query: 'career transition from iOS to applied AI' },
  { group: 'prose', query: 'why Tailscale single hub instead of multi-device sync' },
  { group: 'prose', query: 'scope creep, build the smallest version first' },
  { group: 'paraphrase', query: 'the database driver broke after a runtime upgrade' },
  { group: 'paraphrase', query: 'reward starting a task not finishing it' },
  { group: 'paraphrase', query: 'stop letting one service own my music metadata' },
  { group: 'code_intent', query: 'VIPER plugin filtering architecture for search' },
  { group: 'code_intent', query: 'protocol interface for swapping audio feature providers' },
  { group: 'code_intent', query: 'Slack-style search bar component' },
  { group: 'code_intent', query: 'parse the ChatGPT mapping / current_node tree' },
]

const dir = process.env.TELEMETRY_DIR
if (!dir) { console.error('TELEMETRY_DIR not set'); process.exit(1) }
fs.mkdirSync(dir, { recursive: true })

const config = getEmbeddingConfig()
const db = new Database(resolveDbPath(), { readonly: true })
loadVecExtension(db)

function ftsQuery(q) {
  const cleaned = q.trim().replace(/["'()*]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const tokens = cleaned.split(' ')
  return tokens.map((t, i) => i === tokens.length - 1 ? `"${t}"*` : `"${t}"`).join(' ')
}

function snippetAround(text, query, span = 240) {
  if (!text) return ''
  const lower = text.toLowerCase()
  let pos = -1
  for (const token of query.toLowerCase().split(/\s+/).filter(t => t.length > 2)) {
    pos = lower.indexOf(token)
    if (pos !== -1) break
  }
  if (pos === -1) return text.slice(0, span) + (text.length > span ? '…' : '')
  const start = Math.max(0, pos - Math.floor(span / 3))
  const end = Math.min(text.length, start + span)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

function ftsRows(query, limit) {
  const fts = ftsQuery(query)
  if (!fts) return []
  return db.prepare(`
    SELECT m.id as message_id, m.conv_id, m.role, m.text, m.has_code, c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)
      AND m.is_active_branch = 1
    ORDER BY m.create_time DESC
    LIMIT ?
  `).all(fts, limit)
}

function vectorRows(queryVec, limit) {
  return db.prepare(`
    SELECT v.message_id, v.distance, e.conversation_id as conv_id, e.role,
           m.text, m.has_code, c.title as conv_title
    FROM ${quoteIdentifier(config.vectorTable)} v
    JOIN message_embeddings e ON e.message_id = v.message_id
    JOIN messages m ON m.id = v.message_id
    JOIN conversations c ON c.id = e.conversation_id
    WHERE v.embedding MATCH ? AND k = ?
      AND e.embedding_model = ? AND e.embedding_dim = ?
    ORDER BY v.distance
  `).all(queryVec, limit, config.model, config.dims)
}

function shape(row, query, score) {
  return {
    conv_title: row.conv_title,
    msg_id: row.message_id,
    role: row.role,
    has_code: !!row.has_code,
    score,
    snippet: snippetAround(row.text, query),
  }
}

function fuse(ftsHits, vecHits, query) {
  const scores = new Map()
  const add = (hits, key) => hits.forEach((hit, rank) => {
    const entry = scores.get(hit.message_id) ?? { hit, score: 0 }
    entry.score += 1 / (60 + rank + 1)
    entry[key] = rank + 1
    scores.set(hit.message_id, entry)
  })
  add(ftsHits, 'fts_rank')
  add(vecHits, 'vector_rank')
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, K)
    .map(e => ({
      ...shape(e.hit, query, Number(e.score.toFixed(6))),
      fts_rank: e.fts_rank ?? null,
      vector_rank: e.vector_rank ?? null,
    }))
}

const results = []
for (const probe of PROBES) {
  const ftsHits = ftsRows(probe.query, CANDIDATE_LIMIT)
  const queryVec = await ollamaEmbed(probe.query)
  const vecHits = vectorRows(queryVec, CANDIDATE_LIMIT)

  results.push({
    group: probe.group,
    query: probe.query,
    fts: ftsHits.slice(0, K).map((r, i) => shape(r, probe.query, `fts_rank_${i + 1}`)),
    vector: vecHits.slice(0, K).map(r => shape(r, probe.query, Number(r.distance.toFixed(4)))),
    fused: fuse(ftsHits, vecHits, probe.query),
  })
  console.log(`[eval] ${probe.group} | "${probe.query}" -> fts:${ftsHits.length} vec:${vecHits.length}`)
}

const indexed = db.prepare(
  'SELECT COUNT(*) n FROM message_embeddings WHERE embedding_model = ? AND embedding_dim = ?'
).get(config.model, config.dims).n

const output = {
  generated_at: new Date().toISOString(),
  model: config.model,
  dims: config.dims,
  vector_table: config.vectorTable,
  indexed_messages: indexed,
  k: K,
  candidate_limit_per_leg: CANDIDATE_LIMIT,
  probes: results,
}

fs.writeFileSync(path.join(dir, 'retrieval-eval.json'), JSON.stringify(output, null, 2))
console.log(`retrieval-eval.json written (${results.length} probes, ${indexed} indexed messages)`)
db.close()
