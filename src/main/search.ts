import { ipcMain } from 'electron'
import Store from 'electron-store'
import { getDB } from './db'

export interface SearchFlags {
  restoreSearchResults: boolean
  semanticSearchSuite: boolean
}

export interface FileSearchResult {
  id: string
  conv_id: string
  conv_title: string
  role: string
  text: string
  word_count: number
  has_code: number
  has_image: number
  code_langs: string | null
  create_time: number | null
  model: string | null
  is_active_branch: number
  branch_index: number
  source: 'chatgpt' | 'claude'
  file_id: number
  file_name: string | null
  file_type: string | null
  file_size: number | null
  file_text: string
}

const store = new Store<{ searchFlags: SearchFlags }>({
  name: 'historykit-settings',
})

const DEFAULT_FLAGS: SearchFlags = {
  restoreSearchResults: true,
  semanticSearchSuite: false,
}

function getFlags(): SearchFlags {
  return {
    ...DEFAULT_FLAGS,
    ...(store.get('searchFlags') || {}),
  }
}

function setFlags(patch: Partial<SearchFlags>): SearchFlags {
  const next = {
    ...getFlags(),
    ...patch,
  }
  store.set('searchFlags', next)
  return next
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ')
}

function toMatchQuery(query: string): string {
  // Strip FTS5 operators and quote tokens so user input can't raise an
  // fts5 syntax error.
  const normalized = normalizeQuery(query).replace(/["'()*]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.split(' ').filter(Boolean).map((token) => `"${token}"*`).join(' ')
}

function escapeLike(input: string): string {
  return input.replace(/[\%_]/g, '\\$&')
}

export function registerSearchIpc() {
  ipcMain.handle('search:flags:get', async () => getFlags())
  ipcMain.handle('search:flags:set', async (_event, patch: Partial<SearchFlags>) => setFlags(patch || {}))
  ipcMain.handle('search:files', async (_event, params: { query?: string; limit?: number; offset?: number }) => {
    const db = getDB()
    const query = normalizeQuery(params.query || '')
    const limit = params.limit ?? 200
    const offset = params.offset ?? 0

    if (!query) {
      return []
    }

    const matchQuery = toMatchQuery(query)
    if (!matchQuery) {
      return []
    }
    const likeQuery = `%${escapeLike(query)}%`

    return db.prepare([
      'SELECT',
      '  m.id,',
      '  m.conv_id,',
      '  c.title AS conv_title,',
      '  m.role,',
      '  m.text,',
      '  m.word_count,',
      '  m.has_code,',
      '  m.has_image,',
      '  m.code_langs,',
      '  m.create_time,',
      '  m.model,',
      '  m.is_active_branch,',
      '  m.branch_index,',
      '  m.source,',
      '  ac.id AS file_id,',
      '  ac.file_name,',
      '  ac.file_type,',
      '  ac.file_size,',
      '  ac.content AS file_text',
      'FROM attachment_contents ac',
      'JOIN messages m ON m.id = ac.message_id',
      'JOIN conversations c ON c.id = m.conv_id',
      'WHERE ac.id IN (',
      '  SELECT rowid',
      '  FROM attachment_contents_fts',
      '  WHERE attachment_contents_fts MATCH ?',
      ')',
      '   OR ac.file_name LIKE ?',
      '   OR ac.content LIKE ?',
      'ORDER BY m.create_time DESC',
      'LIMIT ? OFFSET ?',
    ].join('\n')).all(matchQuery, likeQuery, likeQuery, limit, offset) as FileSearchResult[]
  })
}
