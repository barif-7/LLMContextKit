// Usage: TELEMETRY_DIR=telemetry/run-<...> node scripts/embed_audit.mjs
// Writes ${TELEMETRY_DIR}/embed-audit.json: what-gets-embedded rule + code-heavy population stats.
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { resolveDbPath } from '../dist/dbPath.js'
import { getEmbeddingConfig } from '../dist/vec.js'

const dir = process.env.TELEMETRY_DIR
if (!dir) { console.error('TELEMETRY_DIR not set'); process.exit(1) }
fs.mkdirSync(dir, { recursive: true })

const config = getEmbeddingConfig()
const db = new Database(resolveDbPath(), { readonly: true })

// Mirrors the eligibility filter in src/index_embeddings.ts
const ELIGIBLE_WHERE = `
  m.text IS NOT NULL
  AND length(trim(m.text)) >= 20
  AND m.role NOT IN ('tool', 'tool_result')
`

const totals = db.prepare(`
  SELECT
    COUNT(*) AS eligible,
    SUM(m.has_code) AS with_code
  FROM messages m
  WHERE ${ELIGIBLE_WHERE}
`).get()

// code_chars per message from code_blocks; ratio over length(text)
const ratios = db.prepare(`
  SELECT
    COUNT(*) AS n_with_code,
    SUM(CASE WHEN cb.code_chars * 1.0 / length(m.text) > 0.6 THEN 1 ELSE 0 END) AS code_heavy,
    SUM(CASE WHEN cb.code_chars * 1.0 / length(m.text) > 0.9 THEN 1 ELSE 0 END) AS near_pure_code
  FROM messages m
  JOIN (
    SELECT message_id, SUM(length(code)) AS code_chars
    FROM code_blocks GROUP BY message_id
  ) cb ON cb.message_id = m.id
  WHERE ${ELIGIBLE_WHERE}
`).get()

const sampleRows = db.prepare(`
  SELECT m.id, m.has_code, m.code_langs, m.role, length(m.text) AS total_chars,
         COALESCE(cb.code_chars, 0) AS code_chars, m.text
  FROM messages m
  LEFT JOIN (
    SELECT message_id, SUM(length(code)) AS code_chars
    FROM code_blocks GROUP BY message_id
  ) cb ON cb.message_id = m.id
  WHERE ${ELIGIBLE_WHERE}
  ORDER BY (m.id IN (
    SELECT id FROM messages WHERE has_code = 1 ORDER BY random() LIMIT 13
  )) DESC, random()
  LIMIT 25
`).all()

const sample = sampleRows.map((r) => {
  const embedded = r.text.slice(0, config.maxContentChars)
  return {
    id: r.id,
    role: r.role,
    has_code: r.has_code,
    code_langs: r.code_langs,
    total_chars: r.total_chars,
    prose_chars: r.total_chars - r.code_chars,
    code_chars: r.code_chars,
    embedded_chars: embedded.length,
    embedded_head_200: embedded.slice(0, 200),
    embedded_tail_80: embedded.length > 280 ? embedded.slice(-80) : '',
  }
})

const audit = {
  generated_at: new Date().toISOString(),
  embedding_text_rule: 'prose+code',
  detail: {
    source: 'src/index_embeddings.ts + src/importer.ts (verified against DB samples)',
    rule: 'messages.text is embedded verbatim, sliced to maxContentChars. messages.text includes fenced code blocks inline (the importer re-wraps code parts in ``` fences), so code content IS embedded up to the char cap. No chunking: one embedding per message, head-truncation only.',
    max_content_chars: config.maxContentChars,
    context_overflow_retry_chars: [6000, 4000, 2500, 1200],
    min_content_chars: 20,
    excluded_roles: ['tool', 'tool_result'],
  },
  population: {
    eligible_messages: totals.eligible,
    with_has_code: totals.with_code,
    pct_has_code: Number((100 * totals.with_code / totals.eligible).toFixed(1)),
    code_heavy_gt_0_6: ratios.code_heavy,
    pct_code_heavy: Number((100 * ratios.code_heavy / totals.eligible).toFixed(1)),
    near_pure_code_gt_0_9: ratios.near_pure_code,
    note: 'code_chars from sum(length(code_blocks.code)) per message; ratio = code_chars / length(messages.text)',
  },
  sample,
}

fs.writeFileSync(path.join(dir, 'embed-audit.json'), JSON.stringify(audit, null, 2))
console.log(`embed-audit.json written: ${totals.eligible} eligible, ${totals.with_code} with code, ${ratios.code_heavy} code-heavy (>0.6), ${ratios.near_pure_code} near-pure (>0.9)`)
db.close()
