#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const dbPath = process.env.HISTORYKIT_DB_PATH
  || path.join(os.homedir(), 'Library', 'Application Support', 'HistoryKit', 'historykit.db')
const outRoot = path.resolve(process.argv[2] || path.join(os.homedir(), 'Downloads', 'slack-objc'))
const outDir = path.join(outRoot, 'RecoveredReferences', 'UploadedSwiftAttachments')

function runSql(sql) {
  const result = spawnSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 100,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 exited with status ${result.status}`)
  }
  return JSON.parse(result.stdout || '[]')
}

function safeSegment(input) {
  return String(input || 'unknown')
    .replace(/[^\w.+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown'
}

function inferGroup(names) {
  const joined = names.join(' ')
  if (/OrganizationPicker/.test(joined)) return 'OrganizationPicker'
  if (/SearchFiltersPicker/.test(joined)) return 'SearchFiltersPicker'
  if (/SearchFilters|SearchFilterToggle/.test(joined) && !/Tests/.test(joined)) return 'SearchFilters'
  if (/Tests|MockSearchMessages/.test(joined)) return 'SearchTests'
  if (/APIAi|SlackAPI|Autocomplete/.test(joined)) return 'SlackAPI'
  if (/UIColor|SKOrnamentBox|SKGenericEntity/.test(joined)) return 'FileTypeUI'
  return safeSegment(names[0]).replace(/\.swift$/i, '')
}

const sql = `
WITH mt AS (
  SELECT rowid AS msg_rowid, id, conv_id, role, text
  FROM messages
),
swift_atts AS (
  SELECT
    a.id AS attachment_id,
    a.name,
    a.asset_pointer,
    a.size_bytes,
    a.message_id AS upload_message_id,
    a.conv_id,
    c.title AS conversation_title,
    ROW_NUMBER() OVER (PARTITION BY a.message_id ORDER BY a.id) AS rn
  FROM attachments a
  JOIN conversations c ON c.id = a.conv_id
  WHERE lower(a.name) LIKE '%.swift'
),
swift_tools AS (
  SELECT
    m.id AS tool_message_id,
    m.conv_id,
    m.text,
    (
      SELECT u.id
      FROM mt u
      WHERE u.conv_id = m.conv_id
        AND u.role = 'user'
        AND u.msg_rowid < m.msg_rowid
      ORDER BY u.msg_rowid DESC
      LIMIT 1
    ) AS upload_message_id,
    ROW_NUMBER() OVER (
      PARTITION BY (
        SELECT u.id
        FROM mt u
        WHERE u.conv_id = m.conv_id
          AND u.role = 'user'
          AND u.msg_rowid < m.msg_rowid
        ORDER BY u.msg_rowid DESC
        LIMIT 1
      )
      ORDER BY m.msg_rowid
    ) AS rn
  FROM mt m
  WHERE m.role = 'tool'
    AND m.text NOT LIKE 'All the files uploaded%'
    AND m.text <> 'Model set context updated.'
)
SELECT
  a.attachment_id,
  a.name,
  a.asset_pointer,
  a.size_bytes,
  a.upload_message_id,
  a.conv_id,
  a.conversation_title,
  t.tool_message_id,
  t.text AS content,
  length(t.text) AS text_len
FROM swift_atts a
JOIN swift_tools t
  ON t.upload_message_id = a.upload_message_id
 AND t.rn = a.rn
ORDER BY a.attachment_id;
`

const rows = runSql(sql)
if (!rows.length) throw new Error('No .swift attachments found')

const byUpload = new Map()
for (const row of rows) {
  if (!byUpload.has(row.upload_message_id)) byUpload.set(row.upload_message_id, [])
  byUpload.get(row.upload_message_id).push(row)
}

fs.mkdirSync(outDir, { recursive: true })

const manifest = []
for (const [uploadMessageId, groupRows] of byUpload.entries()) {
  const groupName = inferGroup(groupRows.map((row) => row.name))
  const groupDir = path.join(outDir, groupName)
  fs.mkdirSync(groupDir, { recursive: true })

  for (const row of groupRows) {
    const filePath = path.join(groupDir, safeSegment(row.name))
    const content = row.content.endsWith('\n') ? row.content : `${row.content}\n`
    fs.writeFileSync(filePath, content, 'utf8')
    const bytes = Buffer.byteLength(content)
    manifest.push({
      file: path.relative(outRoot, filePath),
      attachment_id: row.attachment_id,
      attachment_name: row.name,
      asset_pointer: row.asset_pointer,
      upload_message_id: uploadMessageId,
      tool_message_id: row.tool_message_id,
      conversation_id: row.conv_id,
      conversation_title: row.conversation_title,
      expected_bytes: row.size_bytes,
      written_bytes: bytes,
      status: bytes === row.size_bytes ? 'ok' : 'size_mismatch',
    })
  }
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const index = [
  '# Uploaded Swift Attachments',
  '',
  `Source database: \`${dbPath}\``,
  `Recovered files: ${manifest.length}`,
  '',
  '| File | Attachment ID | Bytes | Status |',
  '|---|---:|---:|---|',
  ...manifest.map((item) => {
    const displayPath = item.file.startsWith('RecoveredReferences/UploadedSwiftAttachments/')
      ? item.file.slice('RecoveredReferences/UploadedSwiftAttachments/'.length)
      : item.file
    return `| [${displayPath}](./${encodeURI(displayPath)}) | ${item.attachment_id} | ${item.written_bytes} | ${item.status} |`
  }),
]
fs.writeFileSync(path.join(outDir, 'INDEX.md'), index.join('\n') + '\n')

const mismatches = manifest.filter((item) => item.status !== 'ok')
console.log(JSON.stringify({
  dbPath,
  outDir,
  files: manifest.length,
  mismatches: mismatches.length,
}, null, 2))
