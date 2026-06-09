#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const exportPath = process.argv[2]
const dbPath = process.env.HISTORYKIT_DB_PATH
  || path.join(os.homedir(), 'Library', 'Application Support', 'historykit', 'historykit.db')

if (!exportPath) {
  process.stderr.write('Usage: node scripts/import-claude-export.mjs /path/to/claude-export\n')
  process.exit(1)
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g
const URL_RE = /https?:\/\/[^\s<>"')\]},;]+/g

const db = new Database(dbPath)
initSchema()

const files = collectJsonFiles(exportPath)
let conversations = 0
let messages = 0
let skipped = 0
let processed = 0

const mainFile = files.find((file) => path.basename(file) === 'conversations.json')
const orderedFiles = mainFile ? [mainFile, ...files.filter((file) => file !== mainFile)] : files

for (const file of orderedFiles) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rel = path.relative(exportPath, file)
  let result = null
  if (isClaudeMemoriesExport(data)) {
    result = importClaudeMemories(data)
  } else if (isClaudeProjectExport(data)) {
    result = importClaudeProjectDocs(data)
  } else if (normalizeClaudeData(data).length > 0) {
    result = parseClaudeConversations(data)
  }

  if (!result) continue
  processed++
  conversations += result.conversations
  messages += result.messages
  skipped += result.skipped
  process.stdout.write(`[claude-import] ${rel}: ${result.conversations} conversations, ${result.messages} messages\n`)
}

rebuildFts()
process.stdout.write(`[claude-import] done: ${processed} files, ${conversations} conversations, ${messages} messages, ${skipped} skipped\n`)
process.stdout.write(`[claude-import] db: ${dbPath}\n`)

function initSchema() {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = normal')
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      create_time REAL,
      update_time REAL,
      current_node TEXT,
      source TEXT NOT NULL DEFAULT 'chatgpt'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conv_id TEXT NOT NULL REFERENCES conversations(id),
      parent_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      word_count INTEGER NOT NULL DEFAULT 0,
      has_code INTEGER NOT NULL DEFAULT 0,
      has_image INTEGER NOT NULL DEFAULT 0,
      has_audio INTEGER NOT NULL DEFAULT 0,
      code_langs TEXT,
      create_time REAL,
      model TEXT,
      finish_reason TEXT,
      branch_index INTEGER NOT NULL DEFAULT 0,
      is_active_branch INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'chatgpt'
    );
    CREATE TABLE IF NOT EXISTS code_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id),
      lang TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      conv_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'image',
      asset_pointer TEXT,
      name TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      size_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      conv_id TEXT NOT NULL,
      url TEXT NOT NULL,
      domain TEXT,
      title TEXT
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      conv_id TEXT NOT NULL,
      text TEXT NOT NULL,
      create_time REAL
    );
    CREATE TABLE IF NOT EXISTS attachment_contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claude_design_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      project_uuid TEXT,
      project_name TEXT,
      file_path TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      operation TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      content TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);
    CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
    CREATE INDEX IF NOT EXISTS idx_code_message ON code_blocks(message_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conv_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_type ON attachments(type);
    CREATE INDEX IF NOT EXISTS idx_links_conv ON links(conv_id);
    CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conv_id);
    CREATE INDEX IF NOT EXISTS idx_att_content_msg ON attachment_contents(message_id);
    CREATE INDEX IF NOT EXISTS idx_claude_design_project ON claude_design_files(project_name);
    CREATE INDEX IF NOT EXISTS idx_claude_design_path ON claude_design_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_claude_design_conv ON claude_design_files(conv_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content=messages, content_rowid=rowid, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS attachment_contents_fts USING fts5(content, file_name, content=attachment_contents, content_rowid=id, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS claude_design_files_fts USING fts5(file_path, file_name, content, project_name, content=claude_design_files, content_rowid=id, tokenize='porter unicode61');
  `)
  migrateColumn('conversations', 'source', `ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'chatgpt'`)
  migrateColumn('messages', 'source', `ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'chatgpt'`)
}

function migrateColumn(table, column, sql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((col) => col.name === column)) db.exec(sql)
}

function rebuildFts() {
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO attachment_contents_fts(attachment_contents_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO claude_design_files_fts(claude_design_files_fts) VALUES('rebuild')`)
}

function collectJsonFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectJsonFiles(full))
    else if (entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

function parseClaudeConversations(data) {
  const rawConvs = normalizeClaudeData(data)
  let totalMessages = 0
  let totalSkipped = 0

  const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES (@id, @title, @create_time, @update_time, @current_node, 'claude')
  `)
  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conv_id, parent_id, role, text, word_count, has_code, has_image, has_audio,
       code_langs, create_time, model, finish_reason, branch_index, is_active_branch, depth, source)
    VALUES
      (@id, @conv_id, @parent_id, @role, @text, @word_count, @has_code, @has_image, 0,
       @code_langs, @create_time, NULL, NULL, 0, 1, @depth, 'claude')
  `)
  const insertCode = db.prepare(`INSERT INTO code_blocks (message_id, lang, code, position) VALUES (@message_id, @lang, @code, @position)`)
  const insertAttachmentContent = db.prepare(`INSERT INTO attachment_contents (message_id, file_name, file_type, file_size, content) VALUES (@message_id, @file_name, @file_type, @file_size, @content)`)
  const insertAttachment = db.prepare(`INSERT INTO attachments (message_id, conv_id, type, asset_pointer, name, mime_type, width, height, size_bytes) VALUES (@message_id, @conv_id, @type, @asset_pointer, @name, @mime_type, NULL, NULL, @size_bytes)`)
  const insertLink = db.prepare(`INSERT INTO links (message_id, conv_id, url, domain, title) VALUES (@message_id, @conv_id, @url, @domain, NULL)`)
  const insertDesignFile = db.prepare(`
    INSERT INTO claude_design_files
      (conv_id, message_id, project_uuid, project_name, file_path, file_name, file_type, operation, source_kind, content, hidden, created_at)
    VALUES
      (@conv_id, @message_id, @project_uuid, @project_name, @file_path, @file_name, @file_type, @operation, @source_kind, @content, @hidden, @created_at)
  `)

  db.transaction(() => {
    for (let ci = 0; ci < rawConvs.length; ci++) {
      const conv = rawConvs[ci]
      const convId = conv.uuid || `claude_conv_${ci}`
      const rawMessages = Array.isArray(conv.chat_messages) ? conv.chat_messages : Array.isArray(conv.messages) ? conv.messages : []
      const currentNode = rawMessages.at(-1)?.uuid || ''
      const title = (conv.name || conv.title || 'Untitled conversation') === 'Chat' && conv.project?.name
        ? conv.project.name
        : (conv.name || conv.title || 'Untitled conversation')

      deleteConversationChildren(convId)
      insertConv.run({
        id: convId,
        title,
        create_time: toUnixSeconds(conv.created_at),
        update_time: toUnixSeconds(conv.updated_at),
        current_node: currentNode,
      })

      let previousMessageId = null
      for (let mi = 0; mi < rawMessages.length; mi++) {
        const msg = rawMessages[mi]
        if (!msg || typeof msg !== 'object') {
          totalSkipped++
          continue
        }
        const msgId = msg.uuid || `${convId}_msg_${mi}`
        const text = extractMessageText(msg)
        const allAttachments = [
          ...(Array.isArray(msg.attachments) ? msg.attachments : []),
          ...(Array.isArray(msg.content?.attachments) ? msg.content.attachments : []),
        ]
        const files = Array.isArray(msg.files) ? msg.files : []
        const codeBlocks = extractCodeBlocks(text)
        const designFiles = extractClaudeDesignFiles(conv, msg, msgId)
        const attachmentContents = allAttachments.filter((a) => typeof a?.extracted_content === 'string' && a.extracted_content.trim())
        const hasImage = files.length > 0 || allAttachments.some((a) => String(a?.file_type || a?.type || '').startsWith('image/'))
        if (!text.trim() && codeBlocks.length === 0 && attachmentContents.length === 0 && designFiles.length === 0 && !hasImage) {
          totalSkipped++
          previousMessageId = msgId
          continue
        }

        insertMsg.run({
          id: msgId,
          conv_id: convId,
          parent_id: previousMessageId,
          role: normalizeRole(msg),
          text,
          word_count: text.split(/\s+/).filter(Boolean).length,
          has_code: codeBlocks.length ? 1 : 0,
          has_image: hasImage ? 1 : 0,
          code_langs: codeBlocks.length ? JSON.stringify([...new Set(codeBlocks.map((block) => block.lang).filter(Boolean))]) : null,
          create_time: toUnixSeconds(msg.created_at),
          depth: mi,
        })
        codeBlocks.forEach((block, position) => insertCode.run({ message_id: msgId, lang: block.lang, code: block.code, position }))
        attachmentContents.forEach((attachment) => insertAttachmentContent.run({
          message_id: msgId,
          file_name: attachment.file_name || attachment.name || null,
          file_type: attachment.file_type || attachment.type || null,
          file_size: attachment.file_size || null,
          content: attachment.extracted_content,
        }))
        allAttachments.forEach((attachment) => insertAttachment.run({
          message_id: msgId,
          conv_id: convId,
          type: inferAttachmentType(attachment),
          asset_pointer: attachment.id || null,
          name: attachment.file_name || attachment.name || null,
          mime_type: attachment.file_type || attachment.type || null,
          size_bytes: attachment.file_size || null,
        }))
        extractLinks(text).forEach((link) => insertLink.run({ message_id: msgId, conv_id: convId, ...link }))
        designFiles.forEach((file) => insertDesignFile.run(file))
        totalMessages++
        previousMessageId = msgId
      }
    }
  })()

  return { conversations: rawConvs.length, messages: totalMessages, skipped: totalSkipped }
}

function deleteConversationChildren(convId) {
  db.prepare(`DELETE FROM code_blocks WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`).run(convId)
  db.prepare(`DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`).run(convId)
  db.prepare(`DELETE FROM claude_design_files WHERE conv_id = ?`).run(convId)
  db.prepare(`DELETE FROM attachments WHERE conv_id = ?`).run(convId)
  db.prepare(`DELETE FROM links WHERE conv_id = ?`).run(convId)
  db.prepare(`DELETE FROM memories WHERE conv_id = ?`).run(convId)
  db.prepare(`DELETE FROM messages WHERE conv_id = ?`).run(convId)
}

function importClaudeMemories(data) {
  const insertConv = db.prepare(`INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source) VALUES (@id, 'Claude Memories', @time, @time, @current_node, 'claude')`)
  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conv_id, parent_id, role, text, word_count, has_code, has_image, has_audio, code_langs, create_time, model, finish_reason, branch_index, is_active_branch, depth, source)
    VALUES
      (@id, @conv_id, NULL, 'system', @text, @word_count, 0, 0, 0, NULL, @time, NULL, NULL, 0, 1, @depth, 'claude')
  `)
  const insertMemory = db.prepare(`INSERT INTO memories (message_id, conv_id, text, create_time) VALUES (@message_id, @conv_id, @text, @time)`)
  let count = 0
  let totalSkipped = 0
  const time = Date.now() / 1000
  db.transaction(() => {
    for (let i = 0; i < data.length; i++) {
      const text = data[i]?.conversations_memory?.trim()
      if (!text) {
        totalSkipped++
        continue
      }
      const convId = `claude_memory_${data[i].account_uuid || i}`
      const msgId = `${convId}_${i}`
      db.prepare(`DELETE FROM memories WHERE conv_id = ?`).run(convId)
      db.prepare(`DELETE FROM messages WHERE conv_id = ?`).run(convId)
      insertConv.run({ id: convId, time, current_node: msgId })
      insertMsg.run({ id: msgId, conv_id: convId, text, word_count: text.split(/\s+/).filter(Boolean).length, time, depth: i })
      insertMemory.run({ message_id: msgId, conv_id: convId, text, time })
      count++
    }
  })()
  return { conversations: count ? 1 : 0, messages: count, skipped: totalSkipped }
}

function importClaudeProjectDocs(project) {
  const docs = Array.isArray(project.docs) ? project.docs : []
  const convId = `claude_project_${project.uuid || project.name || 'unknown'}`
  const createdAt = toUnixSeconds(project.created_at) || Date.now() / 1000
  const updatedAt = toUnixSeconds(project.updated_at) || createdAt
  const insertConv = db.prepare(`INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source) VALUES (@id, @title, @create_time, @update_time, @current_node, 'claude')`)
  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conv_id, parent_id, role, text, word_count, has_code, has_image, has_audio, code_langs, create_time, model, finish_reason, branch_index, is_active_branch, depth, source)
    VALUES
      (@id, @conv_id, NULL, 'system', @text, @word_count, @has_code, 0, 0, @code_langs, @create_time, NULL, NULL, 0, 1, @depth, 'claude')
  `)
  const insertAttachmentContent = db.prepare(`INSERT INTO attachment_contents (message_id, file_name, file_type, file_size, content) VALUES (@message_id, @file_name, @file_type, NULL, @content)`)
  const insertDesignFile = db.prepare(`
    INSERT INTO claude_design_files
      (conv_id, message_id, project_uuid, project_name, file_path, file_name, file_type, operation, source_kind, content, hidden, created_at)
    VALUES
      (@conv_id, @message_id, @project_uuid, @project_name, @file_path, @file_name, @file_type, 'project_doc', 'project_doc', @content, 0, @created_at)
  `)
  let count = 0
  let totalSkipped = 0
  db.transaction(() => {
    deleteConversationChildren(convId)
    insertConv.run({
      id: convId,
      title: `Claude Project: ${project.name || 'Project'}`,
      create_time: createdAt,
      update_time: updatedAt,
      current_node: docs.length ? `${convId}_${docs.at(-1)?.uuid || docs.length - 1}` : '',
    })
    docs.forEach((doc, i) => {
      const content = typeof doc?.content === 'string' ? doc.content : ''
      if (!content.trim()) {
        totalSkipped++
        return
      }
      const fileName = doc.filename || `project-doc-${i + 1}.md`
      const fileType = inferFileType(fileName) || 'md'
      const msgId = `${convId}_${doc.uuid || i}`
      const createTime = toUnixSeconds(doc.created_at) || createdAt
      insertMsg.run({
        id: msgId,
        conv_id: convId,
        text: content,
        word_count: content.split(/\s+/).filter(Boolean).length,
        has_code: content.includes('```') ? 1 : 0,
        code_langs: content.includes('```') ? JSON.stringify(['markdown']) : null,
        create_time: createTime,
        depth: i,
      })
      insertAttachmentContent.run({ message_id: msgId, file_name: fileName, file_type: fileType, content })
      insertDesignFile.run({
        conv_id: convId,
        message_id: msgId,
        project_uuid: project.uuid || null,
        project_name: project.name || 'Claude Project',
        file_path: fileName,
        file_name: fileName,
        file_type: fileType,
        content,
        created_at: createTime,
      })
      count++
    })
  })()
  return { conversations: count ? 1 : 0, messages: count, skipped: totalSkipped }
}

function isClaudeMemoriesExport(data) {
  return Array.isArray(data) && data.some((item) => typeof item?.conversations_memory === 'string')
}

function isClaudeProjectExport(data) {
  return !!data && typeof data === 'object' && Array.isArray(data.docs)
}

function normalizeClaudeData(data) {
  if (Array.isArray(data)) return data.filter(isClaudeConversation)
  if (isClaudeConversation(data)) return [data]
  return []
}

function isClaudeConversation(value) {
  if (!value || typeof value !== 'object') return false
  if ('chat_messages' in value) return true
  return 'messages' in value && Array.isArray(value.messages) && ('title' in value || 'project' in value || 'uuid' in value)
}

function extractMessageText(msg) {
  if (typeof msg.text === 'string') return msg.text
  const content = msg.content
  if (!content) return ''
  const parts = []
  if (typeof content.content === 'string') parts.push(content.content)
  if (Array.isArray(content.content)) {
    parts.push(content.content.map((block) => typeof block === 'string' ? block : block?.type === 'text' ? block.text || '' : '').filter(Boolean).join('\n'))
  }
  if (Array.isArray(content.contentBlocks)) {
    parts.push(content.contentBlocks.map((block) => (block?.type === 'text' || block?.type === 'thinking') ? block.text || '' : '').filter(Boolean).join('\n'))
  }
  return parts.filter(Boolean).join('\n').trim()
}

function extractCodeBlocks(text) {
  const codeBlocks = []
  let match
  CODE_FENCE_RE.lastIndex = 0
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: match[1].trim() || 'text', code: match[2].trim() })
  }
  return codeBlocks
}

function extractLinks(text) {
  const stripped = text.replace(CODE_FENCE_RE, '')
  const links = []
  const seen = new Set()
  let match
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(stripped)) !== null) {
    const url = match[0].replace(/[.)]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    let domain = ''
    try {
      domain = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      domain = ''
    }
    links.push({ url, domain })
  }
  return links
}

function extractClaudeDesignFiles(conv, msg, msgId) {
  const rows = []
  const convId = conv.uuid || ''
  const projectUuid = conv.project?.uuid || null
  const projectName = conv.project?.name || null
  const createdAt = toUnixSeconds(msg.created_at)
  const pushRow = ({ filePath, fileName, fileType, operation, sourceKind, content, hidden }) => {
    const normalized = normalizeFilePath(filePath || fileName || operation)
    rows.push({
      conv_id: convId,
      message_id: msgId,
      project_uuid: projectUuid,
      project_name: projectName,
      file_path: normalized,
      file_name: fileName || fileNameFromPath(normalized),
      file_type: fileType || inferFileType(normalized),
      operation,
      source_kind: sourceKind,
      content: content || null,
      hidden: hidden ? 1 : 0,
      created_at: createdAt,
    })
  }
  const allAttachments = [
    ...(Array.isArray(msg.attachments) ? msg.attachments : []),
    ...(Array.isArray(msg.content?.attachments) ? msg.content.attachments : []),
  ]
  allAttachments.forEach((attachment) => {
    const name = attachment.file_name || attachment.name || attachment.id || 'attachment'
    pushRow({
      filePath: name,
      fileName: name,
      fileType: attachment.file_type || attachment.type || null,
      operation: 'attachment',
      sourceKind: 'attachment',
      content: attachment.extracted_content || attachment.content || null,
      hidden: attachment.hidden,
    })
  })
  const blocks = Array.isArray(msg.content?.contentBlocks) ? msg.content.contentBlocks : []
  blocks.forEach((block) => {
    if (block?.type !== 'tool_call' || !block.toolCall) {
      if (block?.type === 'error' && typeof block.message === 'string') {
        pushRow({ filePath: 'Claude Design error', fileName: 'Claude Design error', fileType: 'error', operation: 'error', sourceKind: 'system', content: block.message })
      }
      return
    }
    const tool = block.toolCall
    const input = tool.input || {}
    const output = typeof tool.output === 'string' ? tool.output : null
    const name = String(tool.name || 'tool_call')
    if (name === 'write_file') {
      pushRow({ filePath: input.path || input.asset || input.filename, operation: name, sourceKind: 'tool_call', content: typeof input.content === 'string' ? input.content : output })
    } else if (name === 'read_file') {
      pushRow({ filePath: input.path, operation: name, sourceKind: 'tool_call', content: output })
    } else if (name === 'str_replace_edit' || name === 'edit_file') {
      pushRow({ filePath: input.path, operation: name, sourceKind: 'tool_call', content: typeof input.new_string === 'string' ? input.new_string : output })
    } else if (name === 'list_files') {
      pushRow({ filePath: input.path || '/', fileName: input.path || '/', fileType: 'folder', operation: name, sourceKind: 'tool_call', content: output })
    } else if (name === 'copy_files' && Array.isArray(input.files)) {
      input.files.forEach((copy) => pushRow({ filePath: copy.dest || copy.src, operation: name, sourceKind: 'tool_call', content: output }))
    } else if (output) {
      pushRow({ filePath: name, fileName: name, fileType: 'tool', operation: name, sourceKind: 'tool_call', content: output })
    }
  })
  return rows
}

function normalizeRole(msg) {
  if (msg.sender) return msg.sender === 'human' ? 'user' : 'assistant'
  if (msg.role) return msg.role === 'user' ? 'user' : 'assistant'
  if (msg.content?.role) return msg.content.role === 'user' ? 'user' : 'assistant'
  return 'unknown'
}

function inferAttachmentType(attachment) {
  const fileType = String(attachment?.file_type || attachment?.type || '').toLowerCase()
  return fileType.startsWith('image/') ? 'image' : 'file'
}

function inferFileType(filePath) {
  const name = fileNameFromPath(filePath)
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return null
  return name.slice(dot + 1).toLowerCase()
}

function fileNameFromPath(filePath) {
  const parts = normalizeFilePath(filePath).split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || normalizeFilePath(filePath)
}

function normalizeFilePath(value) {
  const trimmed = String(value || '').trim()
  return trimmed || 'untitled'
}

function toUnixSeconds(iso) {
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed / 1000 : null
}
