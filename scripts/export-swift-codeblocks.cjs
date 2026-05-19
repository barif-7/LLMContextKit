#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const dbPath = process.env.HISTORYKIT_DB_PATH
  || path.join(os.homedir(), 'Library', 'Application Support', 'HistoryKit', 'historykit.db')
const outDir = path.resolve(process.argv[2] || 'exports/swift-codeblocks')

function slugify(input) {
  return String(input || 'untitled')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    || 'untitled'
}

function inferBaseName(code, title, id) {
  const declaration =
    code.match(/\b(?:final\s+|public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)*\b(?:class|struct|enum|protocol|actor)\s+([A-Za-z_][A-Za-z0-9_]*)/)
    || code.match(/\bextension\s+([A-Za-z_][A-Za-z0-9_.]*)/)
    || code.match(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)/)

  if (declaration?.[1]) return slugify(declaration[1])
  return `${slugify(title)}-${String(id).padStart(5, '0')}`
}

function header(row) {
  const lines = [
    '// Exported from HistoryKit ChatGPT conversation history.',
    `// Conversation: ${row.title || 'Untitled'}`,
    `// Conversation ID: ${row.conv_id}`,
    `// Message ID: ${row.message_id}`,
    `// Code block ID: ${row.id}`,
  ]
  if (row.create_time) lines.push(`// Date: ${new Date(row.create_time * 1000).toISOString()}`)
  return `${lines.join('\n')}\n\n`
}

fs.mkdirSync(outDir, { recursive: true })

const sql = `
  SELECT
    cb.id,
    cb.lang,
    cb.code,
    cb.position,
    m.id AS message_id,
    m.conv_id,
    m.create_time,
    c.title
  FROM code_blocks cb
  JOIN messages m ON m.id = cb.message_id
  JOIN conversations c ON c.id = m.conv_id
  WHERE LOWER(cb.lang) = 'swift'
  ORDER BY m.create_time DESC, cb.id ASC
`

const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
  encoding: 'utf-8',
  maxBuffer: 1024 * 1024 * 200,
})

if (result.status !== 0) {
  throw new Error(result.stderr || `sqlite3 exited with status ${result.status}`)
}

const rows = JSON.parse(result.stdout || '[]')

const usedNames = new Set()
const manifest = []

for (const row of rows) {
  const base = inferBaseName(row.code, row.title, row.id)
  let suffix = 1
  let fileName = `${base}.swift`
  while (usedNames.has(fileName.toLowerCase())) {
    suffix += 1
    fileName = `${base}-${suffix}.swift`
  }
  usedNames.add(fileName.toLowerCase())
  const filePath = path.join(outDir, fileName)

  fs.writeFileSync(filePath, header(row) + row.code.trimEnd() + '\n')
  manifest.push({
    file: fileName,
    code_block_id: row.id,
    conversation_id: row.conv_id,
    conversation_title: row.title,
    message_id: row.message_id,
    date: row.create_time ? new Date(row.create_time * 1000).toISOString() : null,
    bytes: Buffer.byteLength(row.code),
  })
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const indexLines = [
  '# Swift Code Blocks Export',
  '',
  `Source database: \`${dbPath}\``,
  `Generated files: ${manifest.length}`,
  '',
  '| File | Conversation | Date | Bytes |',
  '|---|---|---:|---:|',
]

for (const item of manifest) {
  indexLines.push(
    `| [${item.file}](./${encodeURIComponent(item.file)}) | ${String(item.conversation_title || 'Untitled').replace(/\|/g, '\\|')} | ${item.date || ''} | ${item.bytes} |`
  )
}

fs.writeFileSync(path.join(outDir, 'INDEX.md'), indexLines.join('\n') + '\n')

console.log(JSON.stringify({ dbPath, outDir, files: manifest.length }, null, 2))
