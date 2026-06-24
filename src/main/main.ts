import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { initDB, getDB } from './db'
import { parseConversations } from './parser'
import {
  parseClaudeConversations,
  importClaudeMemories,
  importClaudeProjectDocs,
} from './importers/claude'
import { classifyExport, type ExportClassification } from './format-detector'
import { registerSyncIpc } from './sync'
import { registerSearchIpc } from './search'
import { nodeCommandPath, startBackgroundServices } from './sync'

const isDev = process.env.NODE_ENV === 'development'

let mainWindow: BrowserWindow | null = null

function mcpServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'historykit-mcp', 'dist', 'index.js')
  }
  return path.join(__dirname, '..', 'historykit-mcp', 'dist', 'index.js')
}

function historykitDbPath() {
  return path.join(app.getPath('userData'), 'historykit.db')
}

function claudeConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

function mcpClientConfig() {
  return {
    command: nodeCommandPath(),
    args: [mcpServerPath()],
    env: {
      HISTORYKIT_DB_PATH: historykitDbPath(),
    },
  }
}

function tableExists(name: string) {
  return !!getDB().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0d0d0f',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:4173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initDB()
  registerSyncIpc()
  registerSearchIpc()
  createWindow()

  // Start the MCP HTTP server and sync infrastructure asynchronously in the
  // background so first-launch users don't see a blocked UI.
  startBackgroundServices()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Folder import ─────────────────────────────────────────────────────────────

function collectJsonFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectJsonFiles(full))
    } else if (entry.name.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

// Build an import manifest before writing anything: classify every JSON file
// in the folder so we can report what was found and import in a deterministic
// order (ChatGPT + main Claude conversations first, then projects/memories,
// then individual design chats merged in).
type ManifestKind =
  | 'chatgpt.conversations'
  | 'claude.conversations'
  | 'claude.design_chat'
  | 'claude.project'
  | 'claude.memory'
  | 'unknown'

interface ManifestItem {
  path: string
  relPath: string
  kind: ManifestKind
  isMainFile: boolean
}

function manifestKind(c: ExportClassification): ManifestKind {
  if (c.source === 'chatgpt') return 'chatgpt.conversations'
  if (c.source === 'claude') return `claude.${c.kind}` as ManifestKind
  return 'unknown'
}

// Import priority — lower runs first. Main conversation exports are imported as
// authoritative (replace) before individual design chats are merged on top.
const KIND_ORDER: Record<ManifestKind, number> = {
  'chatgpt.conversations': 0,
  'claude.conversations': 1,
  'claude.project': 2,
  'claude.memory': 3,
  'claude.design_chat': 4,
  unknown: 9,
}

function buildImportManifest(folderPath: string, jsonFiles: string[]): { items: ManifestItem[]; errors: string[] } {
  const items: ManifestItem[] = []
  const errors: string[] = []
  for (const filePath of jsonFiles) {
    const relPath = path.relative(folderPath, filePath)
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const kind = manifestKind(classifyExport(data))
      items.push({ path: filePath, relPath, kind, isMainFile: path.basename(filePath) === 'conversations.json' })
    } catch (err: any) {
      errors.push(`${relPath}: ${err.message}`)
      items.push({ path: filePath, relPath, kind: 'unknown', isMainFile: false })
    }
  }
  items.sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    if (byKind !== 0) return byKind
    // Within a kind, import the canonical conversations.json before single files.
    return Number(b.isMainFile) - Number(a.isMainFile)
  })
  return { items, errors }
}

async function importFolder(folderPath: string) {
  const jsonFiles = collectJsonFiles(folderPath)
  if (jsonFiles.length === 0) {
    return { ok: false, error: 'No JSON files found in folder.' }
  }

  const { items, errors } = buildImportManifest(folderPath, jsonFiles)
  const byKind = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.kind] = (acc[it.kind] || 0) + 1
    return acc
  }, {})
  console.log(`[import:folder] manifest for ${path.basename(folderPath)}:`, byKind)

  let totalConvs = 0
  let totalMsgs = 0
  let totalSkipped = 0
  let filesProcessed = 0
  let filesSkipped = 0

  const importable = items.filter((it) => it.kind !== 'unknown')

  for (const item of importable) {
    const onProgress = (progress: { done: number; total: number; phase: string }) => {
      mainWindow?.webContents.send('import:progress', {
        ...progress,
        phase: `${progress.phase} (${filesProcessed + 1}/${importable.length} files)`,
      })
    }
    try {
      const data = JSON.parse(fs.readFileSync(item.path, 'utf-8'))
      const ctx = { importedFrom: item.relPath }
      console.log(`[import:folder] ${item.relPath} kind=${item.kind}`)
      let result: { conversations: number; messages: number; skipped: number }
      switch (item.kind) {
        case 'chatgpt.conversations':
          // The first/canonical file replaces; subsequent ChatGPT files merge.
          result = await parseConversations(data, onProgress, { merge: !item.isMainFile })
          break
        case 'claude.memory':
          result = importClaudeMemories(data, ctx)
          break
        case 'claude.project':
          result = importClaudeProjectDocs(data, ctx)
          break
        case 'claude.conversations':
        case 'claude.design_chat':
          result = await parseClaudeConversations(data, onProgress, ctx)
          break
        default:
          filesSkipped++
          continue
      }
      totalConvs += result.conversations
      totalMsgs += result.messages
      totalSkipped += result.skipped
      filesProcessed++
    } catch (err: any) {
      errors.push(`${item.relPath}: ${err.message}`)
    }
  }

  filesSkipped += items.length - importable.length

  console.log(`[import:folder] done: ${filesProcessed} files, ${totalConvs} conversations, ${totalMsgs} messages, ${filesSkipped} skipped`)
  if (errors.length) console.error(`[import:folder] errors:`, errors)

  return {
    ok: true,
    format: 'folder',
    conversations: totalConvs,
    messages: totalMsgs,
    skipped: totalSkipped,
    filesProcessed,
    filesSkipped,
    manifest: byKind,
    errors: errors.length ? errors : undefined,
  }
}

// ── IPC: Import file ──────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open conversations export',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile', 'openDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:openFileForMerge', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Add conversation(s)',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths
})

ipcMain.handle('import:file', async (_event, filePath: string) => {
  try {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      return await importFolder(filePath)
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    const classification = classifyExport(data)
    if (classification.source === 'unknown') {
      return {
        ok: false,
        error: 'Unrecognized conversations.json format. Expected ChatGPT or Claude export.',
      }
    }

    const isSingle = data && typeof data === 'object' && !Array.isArray(data)
      && typeof data.mapping === 'object' && !data.conversations
    const kind = `${classification.source}.${classification.kind}`
    console.log(`[import] file=${path.basename(filePath)} kind=${kind} isSingle=${isSingle}`)

    const onProgress = (progress: { done: number; total: number; phase: string }) => {
      mainWindow?.webContents.send('import:progress', progress)
    }
    const ctx = { importedFrom: path.basename(filePath) }

    let result: { conversations: number; messages: number; skipped: number }
    if (classification.source === 'chatgpt') {
      result = await parseConversations(data, onProgress, { merge: isSingle })
    } else if (classification.kind === 'memory') {
      result = importClaudeMemories(data, ctx)
    } else if (classification.kind === 'project') {
      result = importClaudeProjectDocs(data, ctx)
    } else {
      result = await parseClaudeConversations(data, onProgress, ctx)
    }

    console.log(`[import] result: conversations=${result.conversations} messages=${result.messages} merged=${isSingle}`)
    return { ok: true, format: classification.source, kind, merged: isSingle, ...result }
  } catch (err: any) {
    console.error(`[import] error:`, err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('import:merge', async (_event, filePaths: string[]) => {
  let totalConvs = 0, totalMsgs = 0, totalSkipped = 0
  try {
    for (const filePath of filePaths) {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw)
      console.log(`[merge] file=${path.basename(filePath)}`)
      const result = await parseConversations(data, (progress) => {
        mainWindow?.webContents.send('import:progress', progress)
      }, { merge: true })
      totalConvs += result.conversations
      totalMsgs += result.messages
      totalSkipped += result.skipped
    }
    console.log(`[merge] done: ${totalConvs} conversations, ${totalMsgs} messages`)
    return { ok: true, merged: true, conversations: totalConvs, messages: totalMsgs, skipped: totalSkipped }
  } catch (err: any) {
    console.error(`[merge] error:`, err.message)
    return { ok: false, error: err.message }
  }
})

// ── IPC: Search ───────────────────────────────────────────────────────────────

// FTS5 syntax safety — strip operators and quote tokens so queries like
// `"don't` or `foo(bar)` can't raise an fts5 syntax error.
function ftsMatchQuery(q: string): string {
  const cleaned = q.trim().replace(/["'()*]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const tokens = cleaned.split(' ')
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ')
}

ipcMain.handle('search:query', async (_event, params: SearchParams) => {
  const db = getDB()

  let sql = `
    SELECT
      m.id, m.conv_id, m.role, m.text, m.word_count,
      m.has_code, m.has_image, m.code_langs,
      m.create_time, m.branch_index, m.is_active_branch,
      m.source,
      c.title AS conv_title, c.update_time AS conv_updated
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE 1=1
  `
  const args: any[] = []

  const matchQuery = params.query ? ftsMatchQuery(params.query) : ''
  if (matchQuery) {
    sql += ` AND (
      m.rowid IN (
        SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
      )
      OR m.id IN (
        SELECT message_id FROM attachment_contents
        WHERE id IN (
          SELECT rowid FROM attachment_contents_fts WHERE attachment_contents_fts MATCH ?
        )
      )
    )`
    args.push(matchQuery)
    args.push(matchQuery)
  }

  if (params.convId) {
    sql += ` AND m.conv_id = ?`
    args.push(params.convId)
  }

  if (params.role && params.role !== 'all') {
    sql += ` AND m.role = ?`
    args.push(params.role)
  }

  if (params.source && params.source !== 'all') {
    sql += ` AND m.source = ?`
    args.push(params.source)
  }

  // Claude-aware filters. message_metadata is 1:1 with Claude messages and
  // claude_design_files is 1:many, so both are applied via EXISTS to keep the
  // result grain at one row per message (and to leave ChatGPT rows untouched).
  if (params.claudeKind && params.claudeKind !== 'all') {
    sql += ` AND EXISTS (SELECT 1 FROM message_metadata mm WHERE mm.message_id = m.id AND mm.kind = ?)`
    args.push(params.claudeKind)
  }

  if (params.projectName) {
    sql += ` AND EXISTS (SELECT 1 FROM message_metadata mm WHERE mm.message_id = m.id AND mm.project_name = ?)`
    args.push(params.projectName)
  }

  if (params.hasToolCall) {
    sql += ` AND EXISTS (SELECT 1 FROM claude_design_files df WHERE df.message_id = m.id AND df.source_kind = 'tool_call')`
  }

  if (params.filePathContains) {
    sql += ` AND EXISTS (SELECT 1 FROM claude_design_files df WHERE df.message_id = m.id AND df.file_path LIKE ? ESCAPE '\\')`
    args.push(`%${params.filePathContains.replace(/[%_\\]/g, '\\$&')}%`)
  }

  if (params.hasCode) sql += ` AND m.has_code = 1`
  if (params.hasImage) sql += ` AND m.has_image = 1`
  if (params.isLong) sql += ` AND m.word_count > 300`
  if (params.activeBranchOnly) sql += ` AND m.is_active_branch = 1`

  const orderMap: Record<string, string> = {
    newest: 'ORDER BY m.create_time DESC',
    oldest: 'ORDER BY m.create_time ASC',
    longest: 'ORDER BY m.word_count DESC',
    relevance: 'ORDER BY m.create_time DESC',
  }
  sql += ' ' + (orderMap[params.sort || 'newest'] || orderMap.newest)

  const limit = params.limit ?? 51
  const offset = params.offset ?? 0
  sql += ` LIMIT ${limit} OFFSET ${offset}`

  return db.prepare(sql).all(...args)
})

ipcMain.handle('search:stats', async () => {
  const db = getDB()
  const msgs = db.prepare(`SELECT COUNT(*) as n FROM messages`).get() as any
  const convs = db.prepare(`SELECT COUNT(*) as n FROM conversations`).get() as any
  const code = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE has_code=1`).get() as any
  const images = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE has_image=1`).get() as any
  const words = db.prepare(`SELECT SUM(word_count) as n FROM messages`).get() as any
  const files = db.prepare(`SELECT COUNT(*) as n FROM attachments WHERE type='file'`).get() as any
  const links = db.prepare(`SELECT COUNT(*) as n FROM links`).get() as any
  const memoriesCount = db.prepare(`SELECT COUNT(*) as n FROM memories`).get() as any
  const sourceMessageRows = db.prepare(`
    SELECT source, COUNT(*) as messages
    FROM messages
    GROUP BY source
  `).all() as Array<{ source: string; messages: number }>
  const sourceConversationRows = db.prepare(`
    SELECT source, COUNT(*) as conversations
    FROM conversations
    GROUP BY source
  `).all() as Array<{ source: string; conversations: number }>
  const bySource = {
    chatgpt: { messages: 0, conversations: 0 },
    claude: { messages: 0, conversations: 0 },
  }
  sourceMessageRows.forEach((row) => {
    if (row.source === 'chatgpt' || row.source === 'claude') {
      bySource[row.source].messages = row.messages
    }
  })
  sourceConversationRows.forEach((row) => {
    if (row.source === 'chatgpt' || row.source === 'claude') {
      bySource[row.source].conversations = row.conversations
    }
  })
  return {
    messages: msgs.n,
    conversations: convs.n,
    withCode: code.n,
    withImages: images.n,
    totalWords: words.n || 0,
    withFiles: files.n,
    withLinks: links.n,
    withMemories: memoriesCount.n,
    bySource,
  }
})

ipcMain.handle('conversations:list', async () => {
  const db = getDB()
  return db.prepare(`
    SELECT id, title, create_time, update_time,
           (SELECT COUNT(*) FROM messages WHERE conv_id = c.id) as msg_count
    FROM conversations c
    ORDER BY update_time DESC
  `).all()
})

ipcMain.handle('messages:context', async (_event, msgId: string) => {
  const db = getDB()
  const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msgId) as any
  if (!msg) return []

  return db.prepare(`
    SELECT m.*, c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE m.conv_id = ?
      AND m.is_active_branch = ?
    ORDER BY m.create_time ASC
  `).all(msg.conv_id, msg.is_active_branch)
})

ipcMain.handle('messages:byConversation', async (_event, convId: string) => {
  const db = getDB()
  return db.prepare(`
    SELECT m.*, c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE m.conv_id = ?
      AND m.is_active_branch = 1
    ORDER BY m.create_time ASC, m.depth ASC
  `).all(convId)
})

ipcMain.handle('messages:codeblocks', async (_event, msgId: string) => {
  const db = getDB()
  return db.prepare(`SELECT * FROM code_blocks WHERE message_id = ? ORDER BY position`).all(msgId)
})

// ── IPC: Code block search ───────────────────────────────────────────────────

ipcMain.handle('search:codeblocks', async (_event, params: CodeSearchParams) => {
  const db = getDB()
  const { query, langs } = params
  let sql = `
    SELECT cb.id, cb.lang, cb.code, cb.position,
           m.id as message_id, m.text as message_text,
           m.create_time, m.conv_id,
           c.title as conv_title
    FROM code_blocks cb
    JOIN messages m ON m.id = cb.message_id
    JOIN conversations c ON c.id = m.conv_id
    WHERE 1=1
  `
  const args: any[] = []
  if (query) {
    sql += ` AND (cb.code LIKE '%' || ? || '%' OR m.text LIKE '%' || ? || '%')`
    args.push(query, query)
  }
  if (langs && langs.length > 0) {
    sql += ` AND cb.lang IN (${langs.map(() => '?').join(',')})`
    args.push(...langs)
  }
  const limit = params.limit ?? 51
  const offset = params.offset ?? 0
  sql += ` ORDER BY m.create_time DESC LIMIT ${limit} OFFSET ${offset}`
  return db.prepare(sql).all(...args)
})

ipcMain.handle('search:codeLangs', async () => {
  const db = getDB()
  return db.prepare(`
    SELECT lang, COUNT(*) as count
    FROM code_blocks
    WHERE lang != '' AND lang IS NOT NULL
    GROUP BY lang
    ORDER BY count DESC
  `).all()
})

// ── IPC: Attachments, Links, Memories ────────────────────────────────────────

ipcMain.handle('attachments:list', async (_event, type: string) => {
  const db = getDB()
  return db.prepare(`
    SELECT
      a.id, a.message_id, a.conv_id, a.type,
      a.asset_pointer, a.name, a.mime_type,
      a.width, a.height, a.size_bytes,
      m.role, m.text, m.word_count, m.has_code, m.has_image,
      m.code_langs, m.create_time, m.model, m.is_active_branch, m.branch_index,
      c.title AS conv_title, c.update_time AS conv_updated
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN conversations c ON c.id = a.conv_id
    WHERE a.type = ?
    ORDER BY m.create_time DESC
    LIMIT 300
  `).all(type)
})

ipcMain.handle('links:list', async () => {
  const db = getDB()
  return db.prepare(`
    SELECT
      l.id, l.message_id, l.conv_id, l.url, l.domain, l.title,
      m.role, m.text, m.word_count, m.has_code, m.has_image,
      m.code_langs, m.create_time, m.model, m.is_active_branch, m.branch_index,
      c.title AS conv_title, c.update_time AS conv_updated
    FROM links l
    JOIN messages m ON m.id = l.message_id
    JOIN conversations c ON c.id = l.conv_id
    ORDER BY m.create_time DESC
    LIMIT 500
  `).all()
})

ipcMain.handle('memories:list', async () => {
  const db = getDB()
  return db.prepare(`
    SELECT
      mem.id, mem.message_id, mem.conv_id, mem.text, mem.create_time,
      c.title AS conv_title, c.update_time AS conv_updated
    FROM memories mem
    JOIN conversations c ON c.id = mem.conv_id
    ORDER BY mem.create_time DESC
  `).all()
})

// ── IPC: Claude Design Files ────────────────────────────────────────────────

// Distinct Claude project names across all imported messages (not just design
// files) — drives the Project filter dropdown in the search bar.
ipcMain.handle('search:claudeProjects', async () => {
  const db = getDB()
  return db.prepare(`
    SELECT project_name, COUNT(*) AS message_count
    FROM message_metadata
    WHERE project_name IS NOT NULL AND project_name <> ''
    GROUP BY project_name
    ORDER BY message_count DESC
  `).all() as Array<{ project_name: string; message_count: number }>
})

ipcMain.handle('claude:designProjects', async () => {
  const db = getDB()
  return db.prepare(`
    SELECT
      COALESCE(project_uuid, '') AS project_uuid,
      COALESCE(project_name, 'Unassigned') AS project_name,
      COUNT(*) AS file_events,
      COUNT(DISTINCT file_path) AS file_count,
      COUNT(DISTINCT conv_id) AS conversation_count,
      MAX(created_at) AS last_activity
    FROM claude_design_files
    GROUP BY COALESCE(project_uuid, ''), COALESCE(project_name, 'Unassigned')
    ORDER BY last_activity DESC
  `).all()
})

ipcMain.handle('claude:designFiles', async (_event, params: {
  projectName?: string
  operation?: string
  filePath?: string
  query?: string
  limit?: number
  offset?: number
}) => {
  const db = getDB()
  let sql = `
    SELECT
      df.id, df.conv_id, df.message_id, df.project_uuid, df.project_name,
      df.file_path, df.file_name, df.file_type, df.operation, df.source_kind,
      df.content, df.hidden, df.created_at,
      c.title AS conv_title,
      c.update_time AS conv_updated,
      m.role,
      m.text AS message_text
    FROM claude_design_files df
    LEFT JOIN conversations c ON c.id = df.conv_id
    LEFT JOIN messages m ON m.id = df.message_id
    WHERE 1=1
  `
  const args: any[] = []
  if (params?.projectName && params.projectName !== 'all') {
    sql += ` AND COALESCE(df.project_name, 'Unassigned') = ?`
    args.push(params.projectName)
  }
  if (params?.operation && params.operation !== 'all') {
    sql += ` AND df.operation = ?`
    args.push(params.operation)
  }
  if (params?.filePath) {
    sql += ` AND df.file_path = ?`
    args.push(params.filePath)
  }
  if (params?.query?.trim()) {
    const q = `%${params.query.trim()}%`
    sql += ` AND (
      df.file_path LIKE ?
      OR df.file_name LIKE ?
      OR df.project_name LIKE ?
      OR df.content LIKE ?
      OR c.title LIKE ?
      OR m.text LIKE ?
    )`
    args.push(q, q, q, q, q, q)
  }
  sql += ` ORDER BY COALESCE(df.created_at, c.update_time, 0) DESC, df.id DESC`
  const limit = Math.min(params?.limit ?? 300, 1000)
  const offset = params?.offset ?? 0
  sql += ` LIMIT ${limit} OFFSET ${offset}`
  return db.prepare(sql).all(...args)
})

ipcMain.handle('claude:fileTree', async (_event, params: {
  projectName?: string
  query?: string
  limit?: number
}) => {
  const db = getDB()
  let sql = `
    SELECT
      COALESCE(project_name, 'Unassigned') AS project_name,
      file_path,
      file_name,
      file_type,
      MAX(created_at) AS last_activity,
      COUNT(*) AS event_count,
      GROUP_CONCAT(DISTINCT operation) AS operations
    FROM claude_design_files
    WHERE 1=1
  `
  const args: any[] = []
  if (params?.projectName && params.projectName !== 'all') {
    sql += ` AND COALESCE(project_name, 'Unassigned') = ?`
    args.push(params.projectName)
  }
  if (params?.query?.trim()) {
    const q = `%${params.query.trim()}%`
    sql += ` AND (file_path LIKE ? OR file_name LIKE ? OR content LIKE ? OR project_name LIKE ?)`
    args.push(q, q, q, q)
  }
  sql += `
    GROUP BY COALESCE(project_name, 'Unassigned'), file_path
    ORDER BY project_name ASC, file_path ASC
    LIMIT ${Math.min(params?.limit ?? 1000, 3000)}
  `
  return db.prepare(sql).all(...args)
})

// ── IPC: Shell ───────────────────────────────────────────────────────────────

ipcMain.handle('shell:openExternal', (_event, url: string) => {
  return shell.openExternal(url)
})

// ── IPC: Clear DB ────────────────────────────────────────────────────────────

ipcMain.handle('db:clear', async () => {
  const db = getDB()
  if (tableExists('message_embeddings')) db.exec(`DELETE FROM message_embeddings;`)
  db.exec(`DELETE FROM message_metadata; DELETE FROM claude_design_files; DELETE FROM attachment_contents; DELETE FROM code_blocks; DELETE FROM attachments; DELETE FROM links; DELETE FROM memories; DELETE FROM messages; DELETE FROM conversations;`)
  return { ok: true }
})

// ── IPC: MCP integration ─────────────────────────────────────────────────────

ipcMain.handle('mcp:status', async () => {
  const serverPath = mcpServerPath()
  const dbPath = historykitDbPath()
  let nodeVersion: string | null = null

  try {
    nodeVersion = execFileSync('node', ['--version'], { encoding: 'utf-8' }).trim()
  } catch {
    nodeVersion = null
  }

  return {
    serverPath,
    serverBuilt: fs.existsSync(serverPath),
    dbPath,
    dbExists: fs.existsSync(dbPath),
    nodeVersion,
    claudeConfigPath: claudeConfigPath(),
    config: mcpClientConfig(),
    tools: [
      'search_conversations',
      'semantic_search',
      'search_code',
      'get_conversation',
      'get_recent',
      'list_conversations',
      'search_links',
      'list_memories',
      'search_attachments',
      'get_stats',
      'memory_timeline',
      'memory_conflicts',
      'export_memories',
    ],
  }
})

ipcMain.handle('mcp:installClaude', async () => {
  try {
    const serverPath = mcpServerPath()
    if (!fs.existsSync(serverPath)) {
      return { ok: false, error: 'MCP server is not built. Run npm run mcp:build first.' }
    }

    const configPath = claudeConfigPath()
    let config: any = {}
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    }

    config.mcpServers = config.mcpServers || {}
    config.mcpServers.historykit = mcpClientConfig()

    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

    return { ok: true, configPath }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('mcp:showConfig', async () => {
  shell.showItemInFolder(claudeConfigPath())
  return { ok: true }
})

// Types
interface SearchParams {
  query?: string
  convId?: string
  role?: string
  hasCode?: boolean
  hasImage?: boolean
  isLong?: boolean
  activeBranchOnly?: boolean
  sort?: string
  source?: string
  claudeKind?: string          // conversations | design_chat | project | memory | all
  projectName?: string         // exact Claude project name
  hasToolCall?: boolean        // message produced a Claude Design file/tool op
  filePathContains?: string    // substring match on reconstructed file paths
  limit?: number
  offset?: number
}

interface CodeSearchParams {
  query?: string
  langs?: string[]
  limit?: number
  offset?: number
}
