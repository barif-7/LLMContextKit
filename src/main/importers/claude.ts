// Claude importer module — the single entry point for all Claude export
// surfaces. Conversation/design-chat parsing lives in ../parser-claude (it is
// large and stateful); memories and project docs are imported here. Detection
// helpers are re-exported from ../format-detector so callers have one import.

import { getDB } from '../db'
import { wordCount } from './shared'

export { parseClaudeConversations } from '../parser-claude'
export type { ParseResult, ClaudeImportOptions } from '../parser-claude'
export {
  classifyExport,
  isClaudeMemoriesExport,
  isClaudeProjectExport,
} from '../format-detector'
export type { ClaudeKind, ExportClassification } from '../format-detector'

export interface ImportCounts {
  conversations: number
  messages: number
  skipped: number
}

interface ImportContext {
  importedFrom?: string
}

export function importClaudeMemories(data: unknown, ctx: ImportContext = {}): ImportCounts {
  const db = getDB()
  if (!Array.isArray(data) || !data.some((item: any) => typeof item?.conversations_memory === 'string')) {
    return { conversations: 0, messages: 0, skipped: 0 }
  }
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
  const insertMetadata = db.prepare(`
    INSERT OR REPLACE INTO message_metadata
      (message_id, provider, kind, imported_from_file, created_at)
    VALUES (@message_id, 'claude', 'memory', @imported_from_file, @created_at)
  `)
  const deleteMemories = db.prepare(`DELETE FROM memories WHERE conv_id = ?`)
  const deleteMetadata = db.prepare(`DELETE FROM message_metadata WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`)
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE conv_id = ?`)

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
      deleteMetadata.run(convId)
      deleteMemories.run(convId)
      deleteMessages.run(convId)
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
        word_count: wordCount(text),
        create_time: now,
        depth: i,
      })
      insertMemory.run({ message_id: msgId, conv_id: convId, text, create_time: now })
      insertMetadata.run({ message_id: msgId, imported_from_file: ctx.importedFrom ?? null, created_at: now })
      messages++
    }
  })()

  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  return { conversations: messages > 0 ? 1 : 0, messages, skipped }
}

export function importClaudeProjectDocs(data: unknown, ctx: ImportContext = {}): ImportCounts {
  const db = getDB()
  if (!data || typeof data !== 'object' || !Array.isArray((data as any).docs)) {
    return { conversations: 0, messages: 0, skipped: 0 }
  }
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
  const insertMetadata = db.prepare(`
    INSERT OR REPLACE INTO message_metadata
      (message_id, provider, kind, project_uuid, project_name, imported_from_file, created_at)
    VALUES (@message_id, 'claude', 'project', @project_uuid, @project_name, @imported_from_file, @created_at)
  `)
  const deleteAttachmentContents = db.prepare(`DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`)
  const deleteMetadata = db.prepare(`DELETE FROM message_metadata WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`)
  const deleteDesignFiles = db.prepare(`DELETE FROM claude_design_files WHERE conv_id = ?`)
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE conv_id = ?`)

  let messages = 0
  let skipped = 0
  db.transaction(() => {
    deleteAttachmentContents.run(convId)
    deleteMetadata.run(convId)
    deleteDesignFiles.run(convId)
    deleteMessages.run(convId)
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
      const docCreatedAt = Date.parse(doc?.created_at) / 1000 || createdAt
      insertMsg.run({
        id: msgId,
        conv_id: convId,
        text: content,
        word_count: wordCount(content),
        has_code: /```/.test(content) ? 1 : 0,
        code_langs: /```/.test(content) ? JSON.stringify(['markdown']) : null,
        create_time: docCreatedAt,
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
        created_at: docCreatedAt,
      })
      insertMetadata.run({
        message_id: msgId,
        project_uuid: project.uuid ?? null,
        project_name: projectName,
        imported_from_file: ctx.importedFrom ?? null,
        created_at: docCreatedAt,
      })
      messages++
    })
  })()

  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO attachment_contents_fts(attachment_contents_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO claude_design_files_fts(claude_design_files_fts) VALUES('rebuild')`)
  return { conversations: messages > 0 ? 1 : 0, messages, skipped }
}
