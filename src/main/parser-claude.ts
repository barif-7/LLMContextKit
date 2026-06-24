import { getDB } from './db'
import {
  toUnixSeconds,
  wordCount,
  extractCodeBlocks,
  extractLinks,
} from './importers/shared'
import {
  extractMessageText,
  normalizeRole,
  inferAttachmentType,
  collectAttachments,
  extractClaudeDesignFiles,
  normalizeClaudeData,
  ClaudeAttachment,
} from './importers/claude-extract'

type ProgressCallback = (p: { done: number; total: number; phase: string }) => void

export interface ParseResult {
  conversations: number
  messages: number
  skipped: number
  durationMs: number
}

export interface ClaudeImportOptions {
  /** Absolute or relative path the data was read from, recorded in message_metadata. */
  importedFrom?: string
}

interface ClaudeFile {
  file_name?: string
  file_type?: string
}

export async function parseClaudeConversations(
  data: unknown,
  onProgress?: ProgressCallback,
  options: ClaudeImportOptions = {}
): Promise<ParseResult> {
  const start = Date.now()
  const db = getDB()

  const rawConvs = normalizeClaudeData(data)
  let totalMessages = 0
  let skipped = 0

  const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES (@id, @title, @create_time, @update_time, @current_node, 'claude')
  `)

  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conv_id, parent_id, role, text, word_count,
       has_code, has_image, has_audio, code_langs,
       create_time, model, finish_reason,
       branch_index, is_active_branch, depth, source)
    VALUES
      (@id, @conv_id, @parent_id, @role, @text, @word_count,
       @has_code, @has_image, @has_audio, @code_langs,
       @create_time, @model, @finish_reason,
       @branch_index, @is_active_branch, @depth, 'claude')
  `)

  const deleteCode = db.prepare(`DELETE FROM code_blocks WHERE message_id = ?`)
  const deleteAttachmentContent = db.prepare(`DELETE FROM attachment_contents WHERE message_id = ?`)
  const deleteCodeForConv = db.prepare(`DELETE FROM code_blocks WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`)
  const deleteAttachmentForConv = db.prepare(`DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`)
  const deleteMetadataForConv = db.prepare(`DELETE FROM message_metadata WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)`)
  const deleteDesignFilesForConv = db.prepare(`DELETE FROM claude_design_files WHERE conv_id = ?`)
  const deleteAttachmentsMetaForConv = db.prepare(`DELETE FROM attachments WHERE conv_id = ?`)
  const deleteLinksForConv = db.prepare(`DELETE FROM links WHERE conv_id = ?`)
  const deleteMemoriesForConv = db.prepare(`DELETE FROM memories WHERE conv_id = ?`)
  const deleteMessagesForConv = db.prepare(`DELETE FROM messages WHERE conv_id = ?`)

  const embeddingsExist = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_embeddings'").get()
  const deleteEmbeddingsForConv = embeddingsExist
    ? db.prepare(`DELETE FROM message_embeddings WHERE conversation_id = ?`)
    : null

  const insertCode = db.prepare(`
    INSERT INTO code_blocks (message_id, lang, code, position)
    VALUES (@message_id, @lang, @code, @position)
  `)

  const insertAttachmentContent = db.prepare(`
    INSERT INTO attachment_contents (message_id, file_name, file_type, file_size, content)
    VALUES (@message_id, @file_name, @file_type, @file_size, @content)
  `)

  const insertAttachment = db.prepare(`
    INSERT INTO attachments (message_id, conv_id, type, asset_pointer, name, mime_type, width, height, size_bytes)
    VALUES (@message_id, @conv_id, @type, @asset_pointer, @name, @mime_type, @width, @height, @size_bytes)
  `)

  const insertLink = db.prepare(`
    INSERT INTO links (message_id, conv_id, url, domain, title)
    VALUES (@message_id, @conv_id, @url, @domain, @title)
  `)

  const insertDesignFile = db.prepare(`
    INSERT INTO claude_design_files
      (conv_id, message_id, project_uuid, project_name, file_path, file_name, file_type, operation, source_kind, content, hidden, created_at)
    VALUES
      (@conv_id, @message_id, @project_uuid, @project_name, @file_path, @file_name, @file_type, @operation, @source_kind, @content, @hidden, @created_at)
  `)

  const insertMetadata = db.prepare(`
    INSERT OR REPLACE INTO message_metadata
      (message_id, provider, kind, model, stop_reason, tool_name, project_uuid, project_name, artifact_id, workspace_path, imported_from_file, created_at)
    VALUES
      (@message_id, 'claude', @kind, NULL, NULL, NULL, @project_uuid, @project_name, NULL, NULL, @imported_from_file, @created_at)
  `)

  const importedFrom = options.importedFrom ?? null

  const importAll = db.transaction(() => {
    for (let ci = 0; ci < rawConvs.length; ci++) {
      const conv = rawConvs[ci]
      const convId = conv.uuid ?? `claude_conv_${ci}`
      const kind = Array.isArray(conv.chat_messages) ? 'conversations' : 'design_chat'
      const projectUuid = conv.project?.uuid ?? null
      const projectName = conv.project?.name ?? null

      // Handle both chat_messages (conversations.json) and messages (design_chats) formats
      const rawMessages: any[] = Array.isArray(conv.chat_messages)
        ? conv.chat_messages
        : Array.isArray(conv.messages)
          ? conv.messages
          : []

      const currentNode = rawMessages[rawMessages.length - 1]?.uuid ?? ''

      // Use project name if title is generic "Chat"
      let title = conv.name || conv.title || 'Untitled conversation'
      if (title === 'Chat' && conv.project?.name) {
        title = conv.project.name
      }

      // Delete child rows before replacing the conversation (FK enforcement is ON)
      if (deleteEmbeddingsForConv) deleteEmbeddingsForConv.run(convId)
      deleteCodeForConv.run(convId)
      deleteAttachmentForConv.run(convId)
      deleteMetadataForConv.run(convId)
      deleteDesignFilesForConv.run(convId)
      deleteAttachmentsMetaForConv.run(convId)
      deleteLinksForConv.run(convId)
      deleteMemoriesForConv.run(convId)
      deleteMessagesForConv.run(convId)

      insertConv.run({
        id: convId,
        title,
        create_time: toUnixSeconds(conv.created_at),
        update_time: toUnixSeconds(conv.updated_at),
        current_node: currentNode,
      })

      let previousMessageId: string | null = null

      for (let mi = 0; mi < rawMessages.length; mi++) {
        const msg = rawMessages[mi]
        if (!msg || typeof msg !== 'object') {
          skipped++
          continue
        }

        const msgId = msg.uuid ?? `${convId}_msg_${mi}`

        // Extract text: chat_messages format uses `text`, design_chats uses `content.content`
        const text = extractMessageText(msg)

        const allAttachments = collectAttachments(msg)
        const files: ClaudeFile[] = Array.isArray(msg.files) ? msg.files : []
        const codeBlocks = extractCodeBlocks(text)
        const links = extractLinks(text)
        const designFiles = extractClaudeDesignFiles(conv, msg, msgId)
        const attachmentContents = allAttachments.filter(
          (a): a is ClaudeAttachment & { extracted_content: string } =>
            typeof a?.extracted_content === 'string' && a.extracted_content.trim().length > 0
        )
        const hasImage = files.length > 0 || allAttachments.some((a: any) => (a?.file_type ?? a?.type ?? '').startsWith('image/'))

        if (!text.trim() && codeBlocks.length === 0 && attachmentContents.length === 0 && designFiles.length === 0 && !hasImage) {
          skipped++
          previousMessageId = msgId
          continue
        }

        const langs = [...new Set(codeBlocks.map((c) => c.lang).filter(Boolean))]
        deleteCode.run(msgId)
        deleteAttachmentContent.run(msgId)

        // Normalize role: chat_messages uses sender (human/assistant), design_chats uses role (user/assistant)
        const role = normalizeRole(msg)
        const createdAt = toUnixSeconds(msg.created_at)

        insertMsg.run({
          id: msgId,
          conv_id: convId,
          parent_id: previousMessageId,
          role,
          text,
          word_count: wordCount(text),
          has_code: codeBlocks.length > 0 ? 1 : 0,
          has_image: hasImage ? 1 : 0,
          has_audio: 0,
          code_langs: langs.length ? JSON.stringify(langs) : null,
          create_time: createdAt,
          model: null,
          finish_reason: null,
          branch_index: 0,
          is_active_branch: 1,
          depth: mi,
        })

        insertMetadata.run({
          message_id: msgId,
          kind,
          project_uuid: projectUuid,
          project_name: projectName,
          imported_from_file: importedFrom,
          created_at: createdAt,
        })

        codeBlocks.forEach((cb, i) => {
          insertCode.run({
            message_id: msgId,
            lang: cb.lang,
            code: cb.code,
            position: i,
          })
        })

        attachmentContents.forEach((attachment) => {
          insertAttachmentContent.run({
            message_id: msgId,
            file_name: attachment.file_name ?? null,
            file_type: attachment.file_type ?? null,
            file_size: attachment.file_size ?? null,
            content: attachment.extracted_content,
          })
        })

        allAttachments.forEach((attachment: any) => {
          const name = attachment.file_name ?? attachment.name ?? null
          const type = inferAttachmentType(attachment)
          insertAttachment.run({
            message_id: msgId,
            conv_id: convId,
            type,
            asset_pointer: attachment.id ?? null,
            name,
            mime_type: attachment.file_type ?? attachment.type ?? null,
            width: null,
            height: null,
            size_bytes: attachment.file_size ?? null,
          })
        })

        links.forEach((link) => {
          insertLink.run({
            message_id: msgId,
            conv_id: convId,
            url: link.url,
            domain: link.domain,
            title: null,
          })
        })

        designFiles.forEach((file) => insertDesignFile.run(file))

        totalMessages++
        previousMessageId = msgId
      }

      onProgress?.({ done: ci + 1, total: rawConvs.length, phase: 'parsing' })
    }
  })

  importAll()
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO attachment_contents_fts(attachment_contents_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO claude_design_files_fts(claude_design_files_fts) VALUES('rebuild')`)

  return {
    conversations: rawConvs.length,
    messages: totalMessages,
    skipped,
    durationMs: Date.now() - start,
  }
}
