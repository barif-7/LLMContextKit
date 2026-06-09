import { getDB } from './db'

type ProgressCallback = (p: { done: number; total: number; phase: string }) => void

export interface ParseResult {
  conversations: number
  messages: number
  skipped: number
  durationMs: number
}

interface ClaudeAttachment {
  id?: string
  name?: string
  type?: string
  content?: string
  hidden?: boolean
  file_name?: string
  file_size?: number
  file_type?: string
  extracted_content?: string
}

interface ClaudeFile {
  file_name?: string
  file_type?: string
}

interface CodeBlock {
  lang: string
  code: string
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g
const URL_RE = /https?:\/\/[^\s<>"')\]},;]+/g

export async function parseClaudeConversations(
  data: unknown,
  onProgress?: ProgressCallback
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

  const importAll = db.transaction(() => {
    for (let ci = 0; ci < rawConvs.length; ci++) {
      const conv = rawConvs[ci]
      const convId = conv.uuid ?? `claude_conv_${ci}`

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

        const attachments: ClaudeAttachment[] = Array.isArray(msg.attachments) ? msg.attachments : []
        // Attachments can also be inside content object
        const contentAttachments: any[] = msg.content?.attachments ?? []
        const allAttachments = [...attachments, ...contentAttachments]

        const files: ClaudeFile[] = Array.isArray(msg.files) ? msg.files : []
        const codeBlocks = extractCodeBlocks(text)
        const links = extractLinks(text)
        const designFiles = extractClaudeDesignFiles(conv, msg, msgId)
        const attachmentContents = allAttachments.filter(
          (a: any): a is ClaudeAttachment & { extracted_content: string } =>
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

        insertMsg.run({
          id: msgId,
          conv_id: convId,
          parent_id: previousMessageId,
          role,
          text,
          word_count: text ? text.split(/\s+/).filter(Boolean).length : 0,
          has_code: codeBlocks.length > 0 ? 1 : 0,
          has_image: hasImage ? 1 : 0,
          has_audio: 0,
          code_langs: langs.length ? JSON.stringify(langs) : null,
          create_time: toUnixSeconds(msg.created_at),
          model: null,
          finish_reason: null,
          branch_index: 0,
          is_active_branch: 1,
          depth: mi,
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

interface LinkMeta {
  url: string
  domain: string
}

interface ClaudeDesignFileRow {
  conv_id: string
  message_id: string
  project_uuid: string | null
  project_name: string | null
  file_path: string
  file_name: string | null
  file_type: string | null
  operation: string
  source_kind: string
  content: string | null
  hidden: number
  created_at: number | null
}

function extractLinks(text: string): LinkMeta[] {
  if (!text) return []
  const stripped = text.replace(CODE_FENCE_RE, '')
  const seen = new Set<string>()
  const links: LinkMeta[] = []
  let match: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(stripped)) !== null) {
    const url = match[0].replace(/[.)]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    let domain = ''
    try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { domain = '' }
    links.push({ url, domain })
  }
  return links
}

function inferAttachmentType(attachment: any): string {
  const fileType = String(attachment?.file_type ?? attachment?.type ?? '').toLowerCase()
  if (fileType.startsWith('image/')) return 'image'
  return 'file'
}

function extractClaudeDesignFiles(conv: any, msg: any, msgId: string): ClaudeDesignFileRow[] {
  const projectUuid = conv.project?.uuid ?? null
  const projectName = conv.project?.name ?? null
  const convId = conv.uuid ?? ''
  const createdAt = toUnixSeconds(msg.created_at)
  const rows: ClaudeDesignFileRow[] = []

  const pushRow = (input: {
    filePath?: string | null
    fileName?: string | null
    fileType?: string | null
    operation: string
    sourceKind: string
    content?: string | null
    hidden?: boolean
  }) => {
    const filePath = normalizeFilePath(input.filePath || input.fileName || input.operation)
    rows.push({
      conv_id: convId,
      message_id: msgId,
      project_uuid: projectUuid,
      project_name: projectName,
      file_path: filePath,
      file_name: input.fileName ?? fileNameFromPath(filePath),
      file_type: input.fileType ?? inferFileType(filePath),
      operation: input.operation,
      source_kind: input.sourceKind,
      content: input.content ?? null,
      hidden: input.hidden ? 1 : 0,
      created_at: createdAt,
    })
  }

  const allAttachments = [
    ...(Array.isArray(msg.attachments) ? msg.attachments : []),
    ...((Array.isArray(msg.content?.attachments) ? msg.content.attachments : [])),
  ]
  allAttachments.forEach((attachment: ClaudeAttachment) => {
    const name = attachment.file_name ?? attachment.name ?? attachment.id ?? 'attachment'
    const content = attachment.extracted_content ?? attachment.content ?? null
    pushRow({
      filePath: name,
      fileName: name,
      fileType: attachment.file_type ?? attachment.type ?? null,
      operation: 'attachment',
      sourceKind: 'attachment',
      content,
      hidden: attachment.hidden,
    })
  })

  const blocks = Array.isArray(msg.content?.contentBlocks) ? msg.content.contentBlocks : []
  blocks.forEach((block: any) => {
    if (!block || typeof block !== 'object') return
    if (block.type === 'tool_call' && block.toolCall) {
      const tool = block.toolCall
      const input = tool.input ?? {}
      const output = typeof tool.output === 'string' ? tool.output : null
      const name = String(tool.name ?? 'tool_call')

      if (name === 'write_file') {
        pushRow({
          filePath: input.path ?? input.asset ?? input.filename,
          fileName: input.path ? fileNameFromPath(input.path) : input.asset ?? input.filename ?? null,
          operation: name,
          sourceKind: 'tool_call',
          content: typeof input.content === 'string' ? input.content : output,
        })
      } else if (name === 'read_file') {
        pushRow({
          filePath: input.path,
          operation: name,
          sourceKind: 'tool_call',
          content: output,
        })
      } else if (name === 'str_replace_edit' || name === 'edit_file') {
        pushRow({
          filePath: input.path,
          operation: name,
          sourceKind: 'tool_call',
          content: typeof input.new_string === 'string' ? input.new_string : output,
        })
      } else if (name === 'list_files') {
        pushRow({
          filePath: input.path || '/',
          fileName: input.path || '/',
          fileType: 'folder',
          operation: name,
          sourceKind: 'tool_call',
          content: output,
        })
      } else if (name === 'copy_files' && Array.isArray(input.files)) {
        input.files.forEach((copy: any) => {
          pushRow({
            filePath: copy.dest ?? copy.src,
            operation: name,
            sourceKind: 'tool_call',
            content: output,
          })
        })
      } else if (output) {
        pushRow({
          filePath: name,
          fileName: name,
          fileType: 'tool',
          operation: name,
          sourceKind: 'tool_call',
          content: output,
        })
      }
    } else if (block.type === 'error' && typeof block.message === 'string') {
      pushRow({
        filePath: 'Claude Design error',
        fileName: 'Claude Design error',
        fileType: 'error',
        operation: 'error',
        sourceKind: 'system',
        content: block.message,
      })
    }
  })

  return rows
}

function normalizeFilePath(value: string): string {
  const trimmed = String(value || '').trim()
  return trimmed || 'untitled'
}

function fileNameFromPath(filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || normalized
}

function inferFileType(filePath: string): string | null {
  const name = fileNameFromPath(filePath)
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return null
  return name.slice(dot + 1).toLowerCase()
}

function extractMessageText(msg: any): string {
  // conversations.json format: text is directly on the message
  if (typeof msg.text === 'string') return msg.text

  // design_chats format: text is in content.content (string or list of content blocks)
  const content = msg.content
  if (!content) return ''

  const parts: string[] = []
  if (typeof content.content === 'string') parts.push(content.content)

  if (Array.isArray(content.content)) {
    parts.push(content.content
      .map((block: any) => {
        if (typeof block === 'string') return block
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        return ''
      })
      .filter(Boolean)
      .join('\n'))
  }

  if (Array.isArray(content.contentBlocks)) {
    parts.push(content.contentBlocks
      .map((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        if (block?.type === 'thinking' && typeof block.text === 'string') return block.text
        return ''
      })
      .filter(Boolean)
      .join('\n'))
  }

  return parts.filter(Boolean).join('\n').trim()
}

function normalizeRole(msg: any): string {
  // chat_messages format: sender field (human/assistant)
  if (msg.sender) return msg.sender === 'human' ? 'user' : 'assistant'
  // design_chats format: role field (user/assistant)
  if (msg.role) return msg.role === 'user' ? 'user' : 'assistant'
  // fallback: check content.role
  if (msg.content?.role) return msg.content.role === 'user' ? 'user' : 'assistant'
  return 'unknown'
}

function normalizeClaudeData(data: unknown): any[] {
  if (Array.isArray(data)) return data.filter(isClaudeConversation)

  if (data && typeof data === 'object') {
    // Single conversation object (design_chat or standalone)
    if (isClaudeConversation(data)) return [data]
  }

  return []
}

function isClaudeConversation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  // conversations.json format
  if ('chat_messages' in obj) return true
  // design_chats format
  if ('messages' in obj && Array.isArray(obj.messages) && ('title' in obj || 'project' in obj || 'uuid' in obj)) return true
  return false
}

function toUnixSeconds(iso: string | undefined): number | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed / 1000 : null
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const codeBlocks: CodeBlock[] = []
  let match: RegExpExecArray | null
  CODE_FENCE_RE.lastIndex = 0
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: match[1].trim() || 'text', code: match[2].trim() })
  }
  return codeBlocks
}
