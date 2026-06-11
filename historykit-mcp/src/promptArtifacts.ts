import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

type Artifact = {
  artifact_id: string
  source: string
  origin: string
  origin_id: string
  conversation?: string
  conv_id?: string
  message_id?: string
  date: string
  create_time: number | null
  path: string
  kind: string
  chars: number
  snippet: string
  content: string
}

const DEFAULT_REPORT_DIR = '/Users/basilarif/Downloads'

const projectAliases: Record<string, string[]> = {
  'dev-music-service': [
    'dev-music-service',
    'dev music service',
    'dev music',
    'music service',
    'musition',
    'phase music',
    'phase mobile',
    'reccobeats',
    'lrclib',
    'essentia',
    'yt-dlp',
  ],
  historykit: [
    'historykit',
    'llmcontextkit',
    'historykit-mcp',
    'chatgpt export',
    'claude export',
    'fts5',
  ],
}

function fmtTime(ts: number | null): string {
  if (!ts) return 'unknown'
  return new Date(ts * 1000).toISOString()
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}...` : s
}

function firstHeading(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) return trimmed.replace(/^#+\s*/, '').trim()
  }
  return ''
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'untitled'
}

function snippet(text: string, query = '', len = 360): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!query) return truncate(clean, len)
  const index = clean.toLowerCase().indexOf(query.toLowerCase())
  if (index === -1) return truncate(clean, len)
  const start = Math.max(0, index - 120)
  const end = Math.min(clean.length, index + query.length + 220)
  return `${start > 0 ? '...' : ''}${clean.slice(start, end)}${end < clean.length ? '...' : ''}`
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function projectPattern(project?: string): RegExp | null {
  if (!project || project === 'any') return null
  const aliases = projectAliases[project] ?? [project]
  return new RegExp(aliases.map(regexEscape).join('|'), 'i')
}

function promptLike(text: string, pathName = '', strict = true): boolean {
  const head = firstHeading(text)
  const hay = `${pathName}\n${head}\n${text.slice(0, 1600)}`
  const strictMatch =
    /\b(prompt|context pack|session handoff|coding agent prompt|openclaw task)\b/i.test(hay) ||
    /(^|\n)\s*(task|build|objective|requirements|your task|your job)\s*[:\u2014-]/i.test(text) ||
    /^build\s+/i.test(text.trim()) ||
    /^you are\s+/i.test(text.trim())

  if (strict) return strictMatch

  return strictMatch || /\b(architecture|roadmap|decisions|pending work|known issues|next step|handoff)\b/i.test(hay)
}

function matchesProject(text: string, pathName: string, project?: string): boolean {
  const pattern = projectPattern(project)
  if (!pattern) return true
  return pattern.test(`${pathName}\n${text}`)
}

function artifactId(origin: string, id: string | number): string {
  return `${origin}:${id}`
}

function addArtifact(items: Artifact[], seen: Set<string>, artifact: Omit<Artifact, 'chars' | 'snippet'>, query = ''): void {
  const content = artifact.content.trim()
  if (!content) return
  const dedupe = `${artifact.path}\n${content}`
  if (seen.has(dedupe)) return
  seen.add(dedupe)
  items.push({
    ...artifact,
    content,
    chars: content.length,
    snippet: snippet(content, query),
  })
}

function collectPromptArtifacts(
  db: Database.Database,
  options: { project?: string; query?: string; source?: string; strict?: boolean; limit?: number }
): Artifact[] {
  const project = options.project ?? 'any'
  const query = options.query?.trim() ?? ''
  const source = options.source ?? 'any'
  const strict = options.strict ?? true
  const limit = Math.min(Math.max(Number(options.limit ?? 100), 1), 1000)
  const items: Artifact[] = []
  const seen = new Set<string>()

  const messageRows = db.prepare(`
    SELECT m.id AS message_id, m.conv_id, m.source, m.role, m.text, m.create_time, c.title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE (? = 'any' OR m.source = ?)
    ORDER BY m.create_time ASC
  `).all(source, source) as any[]

  for (const row of messageRows) {
    const text = row.text ?? ''
    if (!matchesProject(text, row.title ?? '', project)) continue
    if (query && !`${row.title}\n${text}`.toLowerCase().includes(query.toLowerCase())) continue
    if (!promptLike(text, row.title ?? '', strict)) continue
    addArtifact(items, seen, {
      artifact_id: artifactId('messages', row.message_id),
      source: row.source,
      origin: `messages/${row.role}`,
      origin_id: row.message_id,
      conversation: row.title,
      conv_id: row.conv_id,
      message_id: row.message_id,
      date: fmtTime(row.create_time),
      create_time: row.create_time,
      path: firstHeading(text) || 'HistoryKit message prompt material',
      kind: 'message',
      content: text,
    }, query)
  }

  const codeRows = db.prepare(`
    SELECT cb.id, cb.lang, cb.code, m.id AS message_id, m.conv_id, m.source, m.create_time, c.title
    FROM code_blocks cb
    JOIN messages m ON m.id = cb.message_id
    JOIN conversations c ON c.id = m.conv_id
    WHERE (? = 'any' OR m.source = ?)
    ORDER BY m.create_time ASC
  `).all(source, source) as any[]

  for (const row of codeRows) {
    const code = row.code ?? ''
    if (!matchesProject(code, row.title ?? '', project)) continue
    if (query && !`${row.title}\n${code}`.toLowerCase().includes(query.toLowerCase())) continue
    if (!promptLike(code, '', strict)) continue
    addArtifact(items, seen, {
      artifact_id: artifactId('code_blocks', row.id),
      source: row.source,
      origin: 'code_blocks',
      origin_id: String(row.id),
      conversation: row.title,
      conv_id: row.conv_id,
      message_id: row.message_id,
      date: fmtTime(row.create_time),
      create_time: row.create_time,
      path: firstHeading(code) || 'HistoryKit code block prompt material',
      kind: row.lang || 'text',
      content: code,
    }, query)
  }

  const attachmentRows = db.prepare(`
    SELECT ac.id, ac.file_name, ac.file_type, ac.content, m.id AS message_id,
           m.conv_id, m.source, m.create_time, c.title
    FROM attachment_contents ac
    LEFT JOIN messages m ON m.id = ac.message_id
    LEFT JOIN conversations c ON c.id = m.conv_id
    WHERE (? = 'any' OR m.source = ?)
    ORDER BY COALESCE(m.create_time, c.create_time, 0) ASC
  `).all(source, source) as any[]

  for (const row of attachmentRows) {
    const content = row.content ?? ''
    const name = row.file_name || 'attachment'
    if (!matchesProject(content, name, project)) continue
    if (query && !`${name}\n${content}`.toLowerCase().includes(query.toLowerCase())) continue
    if (!promptLike(content, name, strict)) continue
    addArtifact(items, seen, {
      artifact_id: artifactId('attachment_contents', row.id),
      source: row.source,
      origin: 'attachment_contents',
      origin_id: String(row.id),
      conversation: row.title,
      conv_id: row.conv_id,
      message_id: row.message_id,
      date: fmtTime(row.create_time),
      create_time: row.create_time,
      path: name,
      kind: row.file_type || 'attachment',
      content,
    }, query)
  }

  const designRows = db.prepare(`
    SELECT df.id, df.file_path, df.file_name, df.file_type, df.content,
           df.message_id, df.conv_id, COALESCE(c.source, m.source) AS source,
           COALESCE(df.created_at, m.create_time, c.create_time) AS create_time,
           c.title
    FROM claude_design_files df
    LEFT JOIN messages m ON m.id = df.message_id
    LEFT JOIN conversations c ON c.id = df.conv_id
    WHERE (? = 'any' OR COALESCE(c.source, m.source) = ?)
    ORDER BY COALESCE(df.created_at, m.create_time, c.create_time, 0) ASC
  `).all(source, source) as any[]

  for (const row of designRows) {
    const content = row.content ?? ''
    const name = row.file_path || row.file_name || 'claude_design_file'
    if (!matchesProject(content, name, project)) continue
    if (query && !`${name}\n${content}`.toLowerCase().includes(query.toLowerCase())) continue
    if (!promptLike(content, name, strict)) continue
    addArtifact(items, seen, {
      artifact_id: artifactId('claude_design_files', row.id),
      source: row.source,
      origin: 'claude_design_files',
      origin_id: String(row.id),
      conversation: row.title,
      conv_id: row.conv_id,
      message_id: row.message_id,
      date: fmtTime(row.create_time),
      create_time: row.create_time,
      path: name,
      kind: row.file_type || 'file',
      content,
    }, query)
  }

  return items
    .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0))
    .slice(0, limit)
}

function renderTimelineMarkdown(items: Artifact[], title: string, includeContent: boolean): string {
  const lines = [
    `# ${title}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Total artifacts: ${items.length}`,
    '',
    '## Timeline Index',
    '',
  ]

  items.forEach((item, index) => {
    const anchor = slug(`${index + 1}-${item.date}-${item.source}-${item.path}`)
    lines.push(`${index + 1}. [${item.date} | ${item.source} | ${item.path}](#${anchor}) - ${item.conversation ?? ''} (\`${item.artifact_id}\`)`)
  })

  if (!includeContent) return lines.join('\n')

  lines.push('', '## Timeline Contents', '')
  items.forEach((item, index) => {
    const anchor = slug(`${index + 1}-${item.date}-${item.source}-${item.path}`)
    lines.push(`<a id="${anchor}"></a>`)
    lines.push(`### ${index + 1}. ${item.date} - ${item.path}`)
    lines.push('')
    lines.push(`- Artifact ID: \`${item.artifact_id}\``)
    lines.push(`- Source: \`${item.source}\``)
    if (item.conversation) lines.push(`- Conversation: \`${item.conversation}\``)
    if (item.conv_id) lines.push(`- Conversation ID: \`${item.conv_id}\``)
    if (item.message_id) lines.push(`- Message ID: \`${item.message_id}\``)
    lines.push(`- Origin: \`${item.origin}:${item.origin_id}\``)
    lines.push(`- Kind: \`${item.kind}\``)
    lines.push(`- Characters: \`${item.chars}\``)
    lines.push('')
    lines.push('```markdown')
    lines.push(item.content.replace(/```/g, '``\u200b`'))
    lines.push('```')
    lines.push('')
  })

  return lines.join('\n')
}

export function listPromptArtifacts(args: any, db: Database.Database): string {
  const includeContent = !!args.include_content
  const maxContentChars = Math.min(Math.max(Number(args.max_content_chars ?? 4000), 500), 50000)
  const items = collectPromptArtifacts(db, args).map(item => {
    const base: any = { ...item }
    if (!includeContent) {
      delete base.content
    } else {
      base.content = truncate(item.content, maxContentChars)
      base.content_truncated = item.content.length > maxContentChars
    }
    return base
  })
  return JSON.stringify({ count: items.length, artifacts: items }, null, 2)
}

export function getPromptArtifact(args: any, db: Database.Database): string {
  const id = typeof args.artifact_id === 'string' ? args.artifact_id : ''
  if (!id) return JSON.stringify({ error: 'artifact_id is required' }, null, 2)
  const maxChars = Math.min(Math.max(Number(args.max_chars ?? 100000), 1000), 500000)
  const items = collectPromptArtifacts(db, {
    project: args.project ?? 'any',
    source: args.source ?? 'any',
    strict: args.strict ?? false,
    limit: 1000,
  })
  const item = items.find(candidate => candidate.artifact_id === id)
  if (!item) return JSON.stringify({ error: `No prompt artifact found for ${id}` }, null, 2)
  return JSON.stringify({
    ...item,
    content: truncate(item.content, maxChars),
    content_truncated: item.content.length > maxChars,
  }, null, 2)
}

export function buildPromptTimeline(args: any, db: Database.Database): string {
  const project = args.project ?? 'any'
  const includeContent = args.include_content !== false
  const items = collectPromptArtifacts(db, args)
  return renderTimelineMarkdown(items, `HistoryKit Prompt Timeline${project !== 'any' ? `: ${project}` : ''}`, includeContent)
}

export function writePromptTimelineReport(args: any, db: Database.Database): string {
  const project = args.project ?? 'any'
  const includeContent = args.include_content !== false
  const items = collectPromptArtifacts(db, args)
  const defaultName = project !== 'any'
    ? `${slug(project)}-prompt-timeline.md`
    : 'historykit-prompt-timeline.md'
  const outputPath = typeof args.output_path === 'string' && args.output_path.trim()
    ? args.output_path.trim()
    : path.join(DEFAULT_REPORT_DIR, defaultName)
  const markdown = renderTimelineMarkdown(items, `HistoryKit Prompt Timeline${project !== 'any' ? `: ${project}` : ''}`, includeContent)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, markdown, 'utf8')
  return JSON.stringify({ output_path: outputPath, count: items.length }, null, 2)
}
