import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { initDB, getDB } from './db'
import { parseConversations } from './parser'
import { parseClaudeConversations } from './parser-claude'
import { detectFormat } from './format-detector'
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

function isClaudeMemoriesExport(data: unknown): boolean {
  return Array.isArray(data) && data.some((item: any) => typeof item?.conversations_memory === 'string')
}

function isClaudeProjectExport(data: unknown): boolean {
  return !!data && typeof data === 'object' && Array.isArray((data as any).docs)
}

function importClaudeMemories(data: unknown) {
  if (!isClaudeMemoriesExport(data)) return { conversations: 0, messages: 0, skipped: 0 }
  const db = getDB()
  const rows = data as Array<{ conversations_memory?: string; account_uuid?: string }>

  const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES (@id, @title, @create_time, @update_time, @current_node, 'claude')
  `)
  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conv_id, parent_id, role, text, word_count, has_code, has_image, has_audio,
       code_langs, create_time, model, finish_reason, branch_index, is_active_branch, depth, source)
    VALUES
      (@id, @conv_id, NULL, 'system', @text, @word_count, 0, 0, 0,
       NULL, @create_time, NULL, NULL, 0, 1, @depth, 'claude')
  `)
  const insertMemory = db.prepare(`
    INSERT INTO memories (message_id, conv_id, text, create_time)
    VALUES (@message_id, @conv_id, @text, @create_time)
  `)

  let messages = 0
  let skipped = 0
  const now = Date.now() / 1000

  db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i]?.conversations_memory?.trim()
      if (!text) {
        skipped++
        continue
      }
      const convId = `claude_memory_${rows[i].account_uuid ?? i}`
      const msgId = `${convId}_${i}`
      db.prepare(`DELETE FROM memories WHERE conv_id = ?`).run(convId)
      db.prepare(`DELETE FROM messages WHERE conv_id = ?`).run(convId)
      insertConv.run({
        id: convId,
        title: 'Claude Memories',
        create_time: now,
        update_time: now,
        current_node: msgId,
      })
      insertMsg.run({
        id: msgId,
        conv_id: convId,
        text,
        word_count: text.split(/\s+/).filter(Boolean).length,
        create_time: now,
        depth: i,
      })
      insertMemory.run({ message_id: msgId, conv_id: convId, text, create_time: now })
      messages++
    }
  })()

  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  return { conversations: messages > 0 ? 1 : 0, messages, skipped }
}

function importClaudeProjectDocs(data: unknown) {
  if (!isClaudeProjectExport(data)) return { conversations: 0, messages: 0, skipped: 0 }
  const db = getDB()
  const project = data as any
  const docs = project.docs as any[]
  const convId = `claude_project_${project.uuid ?? project.name ?? 'unknown'}`
  const projectName = project.name ?? 'Claude Project'
  const createdAt = Date.parse(project.created_at) / 1000 || Date.now() / 1000
  const updatedAt = Date.parse(project.updated_at) / 1000 || createdAt

  const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES (@id, @title, @create_time, @update_time, @current_node, 'claude')
  `)
  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conv_id, parent_id, role, text, word_count, has_code, has_image, has_audio,
       code_langs, create_time, model, finish_reason, branch_index, is_active_branch, depth, source)
    VALUES
      (@id, @conv_id, NULL, 'system', @text, @word_count, @has_code, 0, 0,
       @code_langs, @create_time, NULL, NULL, 0, 1, @depth, 'claude')
  `)
  const insertAttachmentContent = db.prepare(`
    INSERT INTO attachment_contents (message_id, file_name, file_type, file_size, content)
    VALUES (@message_id, @file_name, @file_type, NULL, @content)
  `)
  const insertDesignFile = db.prepare(`
    INSERT INTO claude_design_files
      (conv_id, message_id, project_uuid, project_name, file_path, file_name, file_type, operation, source_kind, content, hidden, created_at)
    VALUES
      (@conv_id, @message_id, @project_uuid, @project_name, @file_path, @file_name, @file_type, 'project_doc', 'project_doc', @content, 0, @created_at)
  `)

  let messages = 0
  let skipped = 0
  db.transaction(() => {
    db.prepare(`DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`).run(convId)
    db.prepare(`DELETE FROM claude_design_files WHERE conv_id = ?`).run(convId)
    db.prepare(`DELETE FROM messages WHERE conv_id = ?`).run(convId)
    const currentNode = docs.length ? `${convId}_${docs[docs.length - 1]?.uuid ?? docs.length - 1}` : ''
    insertConv.run({
      id: convId,
      title: `Claude Project: ${projectName}`,
      create_time: createdAt,
      update_time: updatedAt,
      current_node: currentNode,
    })
    docs.forEach((doc, i) => {
      const content = typeof doc?.content === 'string' ? doc.content : ''
      const fileName = doc?.filename ?? `project-doc-${i + 1}.md`
      if (!content.trim()) {
        skipped++
        return
      }
      const msgId = `${convId}_${doc?.uuid ?? i}`
      const fileType = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : 'md'
      insertMsg.run({
        id: msgId,
        conv_id: convId,
        text: content,
        word_count: content.split(/\s+/).filter(Boolean).length,
        has_code: /```/.test(content) ? 1 : 0,
        code_langs: /```/.test(content) ? JSON.stringify(['markdown']) : null,
        create_time: Date.parse(doc?.created_at) / 1000 || createdAt,
        depth: i,
      })
      insertAttachmentContent.run({ message_id: msgId, file_name: fileName, file_type: fileType, content })
      insertDesignFile.run({
        conv_id: convId,
        message_id: msgId,
        project_uuid: project.uuid ?? null,
        project_name: projectName,
        file_path: fileName,
        file_name: fileName,
        file_type: fileType,
        content,
        created_at: Date.parse(doc?.created_at) / 1000 || createdAt,
      })
      messages++
    })
  })()

  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO attachment_contents_fts(attachment_contents_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO claude_design_files_fts(claude_design_files_fts) VALUES('rebuild')`)
  return { conversations: messages > 0 ? 1 : 0, messages, skipped }
}

async function importFolder(folderPath: string) {
  const jsonFiles = collectJsonFiles(folderPath)
  if (jsonFiles.length === 0) {
    return { ok: false, error: 'No JSON files found in folder.' }
  }

  console.log(`[import:folder] found ${jsonFiles.length} JSON files in ${path.basename(folderPath)}`)

  let totalConvs = 0
  let totalMsgs = 0
  let totalSkipped = 0
  let filesProcessed = 0
  let filesSkipped = 0
  const errors: string[] = []

  // Separate the main conversations file (if any) from individual conversation files
  // Import the main file first (full import), then merge individual files
  const mainFile = jsonFiles.find((f) => path.basename(f) === 'conversations.json')
  const otherFiles = jsonFiles.filter((f) => f !== mainFile)

  const onProgress = (progress: { done: number; total: number; phase: string }) => {
    mainWindow?.webContents.send('import:progress', {
      ...progress,
      phase: `${progress.phase} (${filesProcessed + 1}/${jsonFiles.length} files)`,
    })
  }

  // Import main conversations.json first (if present)
  if (mainFile) {
    try {
      const raw = fs.readFileSync(mainFile, 'utf-8')
      const data = JSON.parse(raw)
      const format = detectFormat(data)
      if (format !== 'unknown') {
        console.log(`[import:folder] main file: ${path.basename(mainFile)} format=${format}`)
        const result = format === 'chatgpt'
          ? await parseConversations(data, onProgress)
          : await parseClaudeConversations(data, onProgress)
        totalConvs += result.conversations
        totalMsgs += result.messages
        totalSkipped += result.skipped
        filesProcessed++
      } else {
        filesSkipped++
      }
    } catch (err: any) {
      errors.push(`${path.basename(mainFile)}: ${err.message}`)
    }
  }

  // Then merge individual files (design_chats, etc.)
  for (const filePath of otherFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw)
      if (isClaudeMemoriesExport(data)) {
        console.log(`[import:folder] ${path.relative(folderPath, filePath)} format=claude-memories`)
        const result = importClaudeMemories(data)
        totalConvs += result.conversations
        totalMsgs += result.messages
        totalSkipped += result.skipped
        filesProcessed++
        continue
      }
      if (isClaudeProjectExport(data)) {
        console.log(`[import:folder] ${path.relative(folderPath, filePath)} format=claude-project`)
        const result = importClaudeProjectDocs(data)
        totalConvs += result.conversations
        totalMsgs += result.messages
        totalSkipped += result.skipped
        filesProcessed++
        continue
      }
      const format = detectFormat(data)
      if (format === 'unknown') {
        filesSkipped++
        continue
      }

      console.log(`[import:folder] ${path.relative(folderPath, filePath)} format=${format}`)
      const result = format === 'chatgpt'
        ? await parseConversations(data, onProgress, { merge: true })
        : await parseClaudeConversations(data, onProgress)
      totalConvs += result.conversations
      totalMsgs += result.messages
      totalSkipped += result.skipped
      filesProcessed++
    } catch (err: any) {
      errors.push(`${path.relative(folderPath, filePath)}: ${err.message}`)
    }
  }

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
    const format = detectFormat(data)
    if (format === 'unknown') {
      return {
        ok: false,
        error: 'Unrecognized conversations.json format. Expected ChatGPT or Claude export.',
      }
    }

    const isSingle = data && typeof data === 'object' && !Array.isArray(data)
      && typeof data.mapping === 'object' && !data.conversations
    console.log(`[import] file=${path.basename(filePath)} format=${format} isSingle=${isSingle}`)

    const onProgress = (progress: { done: number; total: number; phase: string }) => {
      mainWindow?.webContents.send('import:progress', progress)
    }

    const result = format === 'chatgpt'
      ? await parseConversations(data, onProgress, { merge: isSingle })
      : await parseClaudeConversations(data, onProgress)

    console.log(`[import] result: conversations=${result.conversations} messages=${result.messages} merged=${isSingle}`)
    return { ok: true, format, merged: isSingle, ...result }
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
  db.exec(`DELETE FROM claude_design_files; DELETE FROM attachment_contents; DELETE FROM code_blocks; DELETE FROM attachments; DELETE FROM links; DELETE FROM memories; DELETE FROM messages; DELETE FROM conversations;`)
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
  limit?: number
  offset?: number
}

interface CodeSearchParams {
  query?: string
  langs?: string[]
  limit?: number
  offset?: number
}
