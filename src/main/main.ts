import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { initDB, getDB } from './db'
import { parseConversations } from './parser'
import { parseClaudeConversations } from './parser-claude'
import { detectFormat } from './format-detector'

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
    command: 'node',
    args: [mcpServerPath()],
    env: {
      HISTORYKIT_DB_PATH: historykitDbPath(),
    },
  }
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

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initDB()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC: Import file ──────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open conversations.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('import:file', async (_event, filePath: string) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    const format = detectFormat(data)
    if (format === 'unknown') {
      return {
        ok: false,
        error: 'Unrecognized conversations.json format. Expected ChatGPT or Claude export.',
      }
    }

    const onProgress = (progress: { done: number; total: number; phase: string }) => {
      mainWindow?.webContents.send('import:progress', progress)
    }
    const result = format === 'chatgpt'
      ? await parseConversations(data, onProgress)
      : await parseClaudeConversations(data, onProgress)

    return { ok: true, format, ...result }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

// ── IPC: Search ───────────────────────────────────────────────────────────────

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

  if (params.query) {
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
    args.push(params.query + '*')
    args.push(params.query + '*')
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
  sql += ` LIMIT 200`

  const rows = db.prepare(sql).all(...args)
  return rows
})

ipcMain.handle('search:stats', async () => {
  const db = getDB()
  const msgs = db.prepare(`SELECT COUNT(*) as n FROM messages`).get() as any
  const convs = db.prepare(`SELECT COUNT(*) as n FROM conversations`).get() as any
  const code = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE has_code=1`).get() as any
  const images = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE has_image=1`).get() as any
  const words = db.prepare(`SELECT SUM(word_count) as n FROM messages`).get() as any
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

  // Return surrounding messages in same conversation, same branch
  return db.prepare(`
    SELECT m.*, c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE m.conv_id = ?
      AND m.is_active_branch = ?
    ORDER BY m.create_time ASC
  `).all(msg.conv_id, msg.is_active_branch)
})

ipcMain.handle('messages:codeblocks', async (_event, msgId: string) => {
  const db = getDB()
  return db.prepare(`SELECT * FROM code_blocks WHERE message_id = ? ORDER BY position`).all(msgId)
})

ipcMain.handle('db:clear', async () => {
  const db = getDB()
  db.exec(`DELETE FROM code_blocks; DELETE FROM messages; DELETE FROM conversations;`)
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
      'search_code',
      'get_conversation',
      'get_recent',
      'list_conversations',
      'get_stats',
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
}
