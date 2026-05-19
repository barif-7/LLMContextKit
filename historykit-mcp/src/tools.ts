/**
 * HistoryKit MCP tools.
 *
 * Each tool is a pure function over the SQLite DB. Tools return structured
 * JSON, formatted as text content for the MCP client. The text is dense and
 * agent-readable — agents prefer compact structured data over decorated UIs.
 */

import type Database from 'better-sqlite3'

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtTime(ts: number | null): string {
  if (!ts) return 'unknown'
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function snippetAround(text: string, query: string, len = 220): string {
  if (!text) return ''
  if (!query) return truncate(text, len)
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i === -1) return truncate(text, len)
  const start = Math.max(0, i - 80)
  const end = Math.min(text.length, i + query.length + 80)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

// FTS5 syntax safety — escape special chars and add prefix matching
function ftsQuery(q: string): string {
  const cleaned = q.trim().replace(/["'()*]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  // Quote each token and add prefix matching on the last token
  const tokens = cleaned.split(' ')
  return tokens.map((t, i) => i === tokens.length - 1 ? `"${t}"*` : `"${t}"`).join(' ')
}

// ── Tool definitions ─────────────────────────────────────────────────────

export const toolDefinitions = [
  {
    name: 'search_conversations',
    description:
      'Full-text search across all ChatGPT conversation history. Returns matching messages with conversation context. Use this when the user references something they discussed before, asks "did I work on X", or when prior context would inform the current task.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (supports phrases). Example: "singleton pattern" or "react hooks"' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
        role: { type: 'string', enum: ['user', 'assistant', 'any'], description: 'Filter by message author (default: any)' },
        source: { type: 'string', enum: ['chatgpt', 'claude', 'any'], description: 'Filter by source export (default: any)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search inside code blocks extracted from ChatGPT conversations. Returns actual code the user has previously written or received, with language and conversation context. Use this when working on code that might have a precedent in history (e.g. "how did I implement X before").',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — matches code content and surrounding message text' },
        lang: { type: 'string', description: 'Filter by language (e.g. "swift", "python", "typescript"). Optional.' },
        source: { type: 'string', enum: ['chatgpt', 'claude', 'any'], description: 'Filter by source export (default: any)' },
        limit: { type: 'number', description: 'Max results (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_conversation',
    description:
      'Retrieve the full active-branch thread of a conversation by its ID. Use after search_conversations to get full context. Returns chronological messages on the current_node path.',
    inputSchema: {
      type: 'object',
      properties: {
        conv_id: { type: 'string', description: 'Conversation ID returned from search_conversations' },
        max_messages: { type: 'number', description: 'Limit number of messages returned (default 50)' },
      },
      required: ['conv_id'],
    },
  },
  {
    name: 'get_recent',
    description:
      'Get the most recent messages from the past N days. Useful when the user references "what I was working on last week" or "the project from yesterday".',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days back to fetch (default 7, max 90)' },
        role: { type: 'string', enum: ['user', 'assistant', 'any'], description: 'Filter by author' },
        source: { type: 'string', enum: ['chatgpt', 'claude', 'any'], description: 'Filter by source export (default: any)' },
        with_code_only: { type: 'boolean', description: 'Only return messages containing code (default false)' },
      },
    },
  },
  {
    name: 'list_conversations',
    description:
      'List conversations from history, sorted by most recent. Useful for "what have I been working on" type questions or to find a conversation by approximate title.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Filter by substring in title' },
        source: { type: 'string', enum: ['chatgpt', 'claude', 'any'], description: 'Filter by source export (default: any)' },
        limit: { type: 'number', description: 'Max results (default 25, max 100)' },
      },
    },
  },
  {
    name: 'get_stats',
    description:
      'Return summary statistics about the indexed history: total conversations, messages, code blocks, date range, languages used. Use this to give the user a sense of what is searchable.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ── Tool implementations ─────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, any>,
  db: Database.Database
): Promise<string> {
  switch (name) {
    case 'search_conversations': return searchConversations(args, db)
    case 'search_code':          return searchCode(args, db)
    case 'get_conversation':     return getConversation(args, db)
    case 'get_recent':           return getRecent(args, db)
    case 'list_conversations':   return listConversations(args, db)
    case 'get_stats':            return getStats(db)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

// ── search_conversations ─────────────────────────────────────────────────

function searchConversations(args: any, db: Database.Database): string {
  const query: string = args.query ?? ''
  const limit = Math.min(Math.max(1, args.limit ?? 10), 50)
  const role: string = args.role ?? 'any'
  const source: string = args.source ?? 'any'

  if (!query.trim()) return JSON.stringify({ error: 'query is required' })

  const fts = ftsQuery(query)
  if (!fts) return JSON.stringify({ results: [], note: 'query produced no searchable tokens' })

  const conditions: string[] = ['m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)']
  const params: any[] = [fts]

  if (role !== 'any') {
    conditions.push('m.role = ?')
    params.push(role)
  }
  if (source !== 'any') {
    conditions.push('m.source = ?')
    params.push(source)
  }

  conditions.push('m.is_active_branch = 1')

  const sql = `
    SELECT m.id, m.conv_id, m.role, m.text, m.word_count, m.has_code, m.has_image, m.source,
           m.create_time, c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.create_time DESC
    LIMIT ?
  `
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as any[]

  const results = rows.map(r => ({
    message_id: r.id,
    conv_id: r.conv_id,
    conv_title: r.conv_title,
    source: r.source,
    role: r.role,
    date: fmtTime(r.create_time),
    word_count: r.word_count,
    has_code: !!r.has_code,
    has_image: !!r.has_image,
    snippet: snippetAround(r.text, query, 240),
  }))

  return JSON.stringify({
    query,
    result_count: results.length,
    results,
    next_step: results.length > 0
      ? 'Call get_conversation with conv_id to retrieve full thread for any of these.'
      : 'No matches. Try broader query or use list_conversations to browse.',
  }, null, 2)
}

// ── search_code ──────────────────────────────────────────────────────────

function searchCode(args: any, db: Database.Database): string {
  const query: string = args.query ?? ''
  const lang: string | undefined = args.lang
  const source: string = args.source ?? 'any'
  const limit = Math.min(Math.max(1, args.limit ?? 10), 30)

  if (!query.trim()) return JSON.stringify({ error: 'query is required' })

  // Use LIKE for code search — FTS5 tokenizes code poorly (drops punctuation)
  const conditions: string[] = ['(cb.code LIKE ? OR m.text LIKE ?)']
  const like = `%${query}%`
  const params: any[] = [like, like]

  if (lang) {
    conditions.push('LOWER(cb.lang) = LOWER(?)')
    params.push(lang)
  }
  if (source !== 'any') {
    conditions.push('m.source = ?')
    params.push(source)
  }

  const sql = `
    SELECT cb.id, cb.lang, cb.code, cb.position,
           m.id as message_id, m.text as message_text, m.create_time, m.source,
           m.conv_id, c.title as conv_title
    FROM code_blocks cb
    JOIN messages m ON m.id = cb.message_id
    JOIN conversations c ON c.id = m.conv_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.create_time DESC
    LIMIT ?
  `
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as any[]

  const results = rows.map(r => ({
    code_block_id: r.id,
    message_id: r.message_id,
    conv_id: r.conv_id,
    conv_title: r.conv_title,
    source: r.source,
    date: fmtTime(r.create_time),
    lang: r.lang || 'text',
    code: r.code,
    surrounding_context: snippetAround(r.message_text || '', query, 200),
  }))

  return JSON.stringify({
    query,
    lang_filter: lang ?? null,
    result_count: results.length,
    results,
  }, null, 2)
}

// ── get_conversation ─────────────────────────────────────────────────────

function getConversation(args: any, db: Database.Database): string {
  const conv_id: string = args.conv_id
  const max = Math.min(args.max_messages ?? 50, 200)

  if (!conv_id) return JSON.stringify({ error: 'conv_id is required' })

  const conv = db.prepare(`
    SELECT id, title, create_time, update_time FROM conversations WHERE id = ?
  `).get(conv_id) as any

  if (!conv) return JSON.stringify({ error: `Conversation not found: ${conv_id}` })

  const messages = db.prepare(`
    SELECT id, role, text, word_count, has_code, has_image, create_time, depth
    FROM messages
    WHERE conv_id = ? AND is_active_branch = 1
    ORDER BY create_time ASC, depth ASC
    LIMIT ?
  `).all(conv_id, max) as any[]

  return JSON.stringify({
    conversation: {
      id: conv.id,
      title: conv.title,
      started: fmtTime(conv.create_time),
      updated: fmtTime(conv.update_time),
    },
    message_count: messages.length,
    messages: messages.map(m => ({
      role: m.role,
      date: fmtTime(m.create_time),
      word_count: m.word_count,
      has_code: !!m.has_code,
      has_image: !!m.has_image,
      text: m.text,
    })),
  }, null, 2)
}

// ── get_recent ───────────────────────────────────────────────────────────

function getRecent(args: any, db: Database.Database): string {
  const days = Math.min(Math.max(1, args.days ?? 7), 90)
  const role: string = args.role ?? 'any'
  const source: string = args.source ?? 'any'
  const codeOnly: boolean = !!args.with_code_only

  const cutoff = Date.now() / 1000 - days * 86400

  const conditions: string[] = ['m.create_time >= ?', 'm.is_active_branch = 1']
  const params: any[] = [cutoff]

  if (role !== 'any') {
    conditions.push('m.role = ?')
    params.push(role)
  }
  if (source !== 'any') {
    conditions.push('m.source = ?')
    params.push(source)
  }
  if (codeOnly) conditions.push('m.has_code = 1')

  const sql = `
    SELECT m.id, m.conv_id, m.role, m.text, m.has_code, m.create_time, m.source,
           c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.create_time DESC
    LIMIT 50
  `

  const rows = db.prepare(sql).all(...params) as any[]

  return JSON.stringify({
    days,
    result_count: rows.length,
    messages: rows.map(r => ({
      conv_id: r.conv_id,
      conv_title: r.conv_title,
      source: r.source,
      role: r.role,
      date: fmtTime(r.create_time),
      has_code: !!r.has_code,
      preview: truncate(r.text, 300),
    })),
  }, null, 2)
}

// ── list_conversations ───────────────────────────────────────────────────

function listConversations(args: any, db: Database.Database): string {
  const titleSub: string | undefined = args.title_contains
  const source: string = args.source ?? 'any'
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100)

  const conditions: string[] = []
  const params: any[] = []

  if (titleSub) {
    conditions.push('LOWER(c.title) LIKE LOWER(?)')
    params.push(`%${titleSub}%`)
  }
  if (source !== 'any') {
    conditions.push('c.source = ?')
    params.push(source)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const sql = `
    SELECT c.id, c.title, c.create_time, c.update_time, c.source,
           (SELECT COUNT(*) FROM messages WHERE conv_id = c.id AND is_active_branch = 1) as msg_count,
           (SELECT COUNT(*) FROM messages WHERE conv_id = c.id AND has_code = 1) as code_msg_count
    FROM conversations c
    ${where}
    ORDER BY c.update_time DESC
    LIMIT ?
  `
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as any[]

  return JSON.stringify({
    result_count: rows.length,
    conversations: rows.map(r => ({
      conv_id: r.id,
      title: r.title || 'Untitled',
      source: r.source,
      last_updated: fmtTime(r.update_time),
      message_count: r.msg_count,
      messages_with_code: r.code_msg_count,
    })),
  }, null, 2)
}

// ── get_stats ────────────────────────────────────────────────────────────

function getStats(db: Database.Database): string {
  const convs = (db.prepare(`SELECT COUNT(*) as n FROM conversations`).get() as any).n
  const msgs  = (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE is_active_branch = 1`).get() as any).n
  const codes = (db.prepare(`SELECT COUNT(*) as n FROM code_blocks`).get() as any).n
  const imgs  = (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE has_image = 1`).get() as any).n
  const range = db.prepare(`SELECT MIN(create_time) as min, MAX(create_time) as max FROM messages WHERE create_time > 0`).get() as any
  const sourceRows = db.prepare(`
    SELECT source, COUNT(*) as messages, COUNT(DISTINCT conv_id) as conversations
    FROM messages
    GROUP BY source
  `).all() as Array<{ source: string; messages: number; conversations: number }>
  const sourceStats = {
    chatgpt: { messages: 0, conversations: 0 },
    claude: { messages: 0, conversations: 0 },
  }
  sourceRows.forEach((row) => {
    const source = row.source
    if (source === 'chatgpt' || source === 'claude') {
      sourceStats[source] = {
        messages: row.messages,
        conversations: row.conversations,
      }
    }
  })

  const langs = db.prepare(`
    SELECT LOWER(lang) as lang, COUNT(*) as n
    FROM code_blocks
    WHERE lang != ''
    GROUP BY LOWER(lang)
    ORDER BY n DESC
    LIMIT 15
  `).all() as any[]

  const topConvs = db.prepare(`
    SELECT c.title, COUNT(m.id) as n
    FROM conversations c
    JOIN messages m ON m.conv_id = c.id
    GROUP BY c.id ORDER BY n DESC LIMIT 5
  `).all() as any[]

  return JSON.stringify({
    conversations: convs,
    messages: msgs,
    code_blocks: codes,
    messages_with_images: imgs,
    by_source: sourceStats,
    earliest_message: fmtTime(range?.min),
    latest_message: fmtTime(range?.max),
    languages: langs.map(l => ({ lang: l.lang, count: l.n })),
    top_conversations: topConvs.map(c => ({ title: c.title, messages: c.n })),
  }, null, 2)
}
