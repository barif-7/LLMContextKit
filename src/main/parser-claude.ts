import { getDB } from './db'

type ProgressCallback = (p: { done: number; total: number; phase: string }) => void

export interface ParseResult {
  conversations: number
  messages: number
  skipped: number
  durationMs: number
}

interface ClaudeAttachment {
  file_name?: string
  file_size?: number
  file_type?: string
  extracted_content?: string
}

interface ClaudeFile {
  file_name?: string
  file_type?: string
}

interface ClaudeMessage {
  uuid?: string
  text?: string
  sender?: string
  created_at?: string
  updated_at?: string
  attachments?: ClaudeAttachment[]
  files?: ClaudeFile[]
}

interface ClaudeConversation {
  uuid?: string
  name?: string
  created_at?: string
  updated_at?: string
  chat_messages?: ClaudeMessage[]
}

interface CodeBlock {
  lang: string
  code: string
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g

export async function parseClaudeConversations(
  data: unknown,
  onProgress?: ProgressCallback
): Promise<ParseResult> {
  const start = Date.now()
  const db = getDB()

  const rawConvs = Array.isArray(data) ? data.filter(isClaudeConversation) : []
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

  const insertCode = db.prepare(`
    INSERT INTO code_blocks (message_id, lang, code, position)
    VALUES (@message_id, @lang, @code, @position)
  `)

  const insertAttachmentContent = db.prepare(`
    INSERT INTO attachment_contents (message_id, file_name, file_type, file_size, content)
    VALUES (@message_id, @file_name, @file_type, @file_size, @content)
  `)

  const importAll = db.transaction(() => {
    for (let ci = 0; ci < rawConvs.length; ci++) {
      const conv = rawConvs[ci]
      const convId = conv.uuid ?? `claude_conv_${ci}`
      const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages : []
      const currentNode = messages[messages.length - 1]?.uuid ?? ''

      insertConv.run({
        id: convId,
        title: conv.name || 'Untitled conversation',
        create_time: toUnixSeconds(conv.created_at),
        update_time: toUnixSeconds(conv.updated_at),
        current_node: currentNode,
      })

      let previousMessageId: string | null = null

      for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi]
        if (!msg || typeof msg !== 'object') {
          skipped++
          continue
        }

        const msgId = msg.uuid ?? `${convId}_msg_${mi}`
        const text = msg.text ?? ''
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
        const files = Array.isArray(msg.files) ? msg.files : []
        const codeBlocks = extractCodeBlocks(text)
        const attachmentContents = attachments.filter(
          (a): a is ClaudeAttachment & { extracted_content: string } =>
            typeof a.extracted_content === 'string' && a.extracted_content.trim().length > 0
        )
        const hasImage = files.length > 0 || attachments.some((a) => (a.file_type ?? '').startsWith('image/'))

        if (!text.trim() && codeBlocks.length === 0 && attachmentContents.length === 0 && !hasImage) {
          skipped++
          previousMessageId = msgId
          continue
        }

        const langs = [...new Set(codeBlocks.map((c) => c.lang).filter(Boolean))]
        deleteCode.run(msgId)
        deleteAttachmentContent.run(msgId)

        insertMsg.run({
          id: msgId,
          conv_id: convId,
          parent_id: previousMessageId,
          role: msg.sender === 'human' ? 'user' : 'assistant',
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

        totalMessages++
        previousMessageId = msgId
      }

      onProgress?.({ done: ci + 1, total: rawConvs.length, phase: 'parsing' })
    }
  })

  importAll()
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  db.exec(`INSERT INTO attachment_contents_fts(attachment_contents_fts) VALUES('rebuild')`)

  return {
    conversations: rawConvs.length,
    messages: totalMessages,
    skipped,
    durationMs: Date.now() - start,
  }
}

function isClaudeConversation(value: unknown): value is ClaudeConversation {
  return !!value && typeof value === 'object' && 'chat_messages' in value
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
