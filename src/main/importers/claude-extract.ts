// Pure Claude-specific parsing helpers (no DB / Electron dependencies).
// These turn raw Claude export JSON into normalised shapes the DB importer
// can persist. Kept side-effect free so they can be unit tested directly.

import {
  toUnixSeconds,
  normalizeFilePath,
  fileNameFromPath,
  inferFileType,
} from './shared'

export interface ClaudeAttachment {
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

export interface ClaudeDesignFileRow {
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

/** Extract the textual content of a Claude message across export shapes. */
export function extractMessageText(msg: any): string {
  // conversations.json format: text is directly on the message
  if (typeof msg?.text === 'string') return msg.text

  // design_chats format: text is in content.content (string or content blocks)
  const content = msg?.content
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

/** Normalise a Claude message sender/role into 'user' | 'assistant' | 'unknown'. */
export function normalizeRole(msg: any): string {
  // chat_messages format: sender field (human/assistant)
  if (msg?.sender) return msg.sender === 'human' ? 'user' : 'assistant'
  // design_chats format: role field (user/assistant)
  if (msg?.role) return msg.role === 'user' ? 'user' : 'assistant'
  // fallback: check content.role
  if (msg?.content?.role) return msg.content.role === 'user' ? 'user' : 'assistant'
  return 'unknown'
}

export function inferAttachmentType(attachment: any): string {
  const fileType = String(attachment?.file_type ?? attachment?.type ?? '').toLowerCase()
  if (fileType.startsWith('image/')) return 'image'
  return 'file'
}

/** Collapse the two attachment locations (msg.attachments + content.attachments). */
export function collectAttachments(msg: any): ClaudeAttachment[] {
  return [
    ...(Array.isArray(msg?.attachments) ? msg.attachments : []),
    ...(Array.isArray(msg?.content?.attachments) ? msg.content.attachments : []),
  ]
}

/** Reconstruct Claude Design file/tool operations from a message. */
export function extractClaudeDesignFiles(conv: any, msg: any, msgId: string): ClaudeDesignFileRow[] {
  const projectUuid = conv?.project?.uuid ?? null
  const projectName = conv?.project?.name ?? null
  const convId = conv?.uuid ?? ''
  const createdAt = toUnixSeconds(msg?.created_at)
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

  collectAttachments(msg).forEach((attachment: ClaudeAttachment) => {
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

  const blocks = Array.isArray(msg?.content?.contentBlocks) ? msg.content.contentBlocks : []
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

/** Return true when a value looks like a Claude conversation object. */
export function isClaudeConversation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  // conversations.json format
  if ('chat_messages' in obj) return true
  // design_chats format
  if ('messages' in obj && Array.isArray(obj.messages) && ('title' in obj || 'project' in obj || 'uuid' in obj)) return true
  return false
}

/** Normalise a raw Claude export (array or single object) to a conversation list. */
export function normalizeClaudeData(data: unknown): any[] {
  if (Array.isArray(data)) return data.filter(isClaudeConversation)
  if (data && typeof data === 'object' && isClaudeConversation(data)) return [data]
  return []
}
