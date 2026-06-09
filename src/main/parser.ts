/**
 * ChatGPT conversations.json parser
 *
 * Key design decisions:
 * - Walk the mapping tree via parent pointers, not insertion order
 * - Reconstruct the active branch by tracing current_node → root
 * - Index ALL branches (not just active), mark is_active_branch accordingly
 * - Handle all content part types: text, image_asset_pointer, audio, tether, tool output
 * - Gracefully handle null messages, missing timestamps, null titles
 */

import { getDB } from './db'

type ProgressCallback = (p: { done: number; total: number; phase: string }) => void

export interface ParseResult {
  conversations: number
  messages: number
  skipped: number
  durationMs: number
}

export interface ParseOptions {
  merge?: boolean
}

export async function parseConversations(
  data: unknown,
  onProgress?: ProgressCallback,
  opts?: ParseOptions
): Promise<ParseResult> {
  const start = Date.now()
  const db = getDB()
  const merge = opts?.merge ?? false

  const rawConvs: any[] = normalizeConversations(data)

  let totalMessages = 0
  let skipped = 0

  const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES (@id, @title, @create_time, @update_time, @current_node, 'chatgpt')
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
       @branch_index, @is_active_branch, @depth, 'chatgpt')
  `)

  const insertCode = db.prepare(`
    INSERT INTO code_blocks (message_id, lang, code, position)
    VALUES (@message_id, @lang, @code, @position)
  `)

  const insertAttachment = db.prepare(`
    INSERT INTO attachments (message_id, conv_id, type, asset_pointer, name, mime_type, width, height, size_bytes)
    VALUES (@message_id, @conv_id, @type, @asset_pointer, @name, @mime_type, @width, @height, @size_bytes)
  `)

  const insertLink = db.prepare(`
    INSERT INTO links (message_id, conv_id, url, domain, title)
    VALUES (@message_id, @conv_id, @url, @domain, @title)
  `)

  const insertMemory = db.prepare(`
    INSERT INTO memories (message_id, conv_id, text, create_time)
    VALUES (@message_id, @conv_id, @text, @create_time)
  `)

  const tableExists = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

  if (!merge) {
    if (tableExists('message_embeddings')) db.exec(`DELETE FROM message_embeddings;`)
    db.exec(`DELETE FROM attachment_contents; DELETE FROM code_blocks; DELETE FROM attachments; DELETE FROM links; DELETE FROM memories; DELETE FROM messages; DELETE FROM conversations;`)
  } else {
    const ids = rawConvs.map((c: any) => c?.id ?? c?.conversation_id).filter(Boolean)
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',')
      if (tableExists('message_embeddings')) {
        db.prepare(`DELETE FROM message_embeddings WHERE conversation_id IN (${placeholders})`).run(...ids)
      }
      db.prepare(`DELETE FROM code_blocks WHERE message_id IN (SELECT id FROM messages WHERE conv_id IN (${placeholders}))`).run(...ids)
      db.prepare(`DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id IN (${placeholders}))`).run(...ids)
      db.prepare(`DELETE FROM attachments WHERE conv_id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM links WHERE conv_id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM memories WHERE conv_id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM messages WHERE conv_id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...ids)
    }
  }

  const importAll = db.transaction(() => {
    for (let ci = 0; ci < rawConvs.length; ci++) {
      const conv = rawConvs[ci]
      if (!conv || typeof conv !== 'object') continue

      const convId: string = conv.id ?? conv.conversation_id ?? conv.conversationId ?? `conv_${ci}`
      const convTitle: string = conv.title || conv.name || 'Untitled conversation'
      const currentNode: string = conv.current_node ?? conv.currentNode ?? ''

      insertConv.run({
        id: convId,
        title: convTitle,
        create_time: conv.create_time ?? null,
        update_time: conv.update_time ?? null,
        current_node: currentNode,
      })

      const mapping: Record<string, any> = conv.mapping ?? {}

      // ── Step 1: Build children map for tree traversal ──────────────────────
      const children: Record<string, string[]> = {}
      for (const nodeId of Object.keys(mapping)) {
        const parent = mapping[nodeId].parent
        if (parent) {
          if (!children[parent]) children[parent] = []
          children[parent].push(nodeId)
        }
      }

      const roots = Object.keys(mapping).filter(
        (id) => !mapping[id].parent || !mapping[mapping[id].parent]
      )

      // ── Step 2: Find the active path by tracing current_node → root ─────────
      const activePath = new Set<string>()
      let cursor = currentNode
      while (cursor && mapping[cursor]) {
        activePath.add(cursor)
        cursor = mapping[cursor].parent ?? ''
      }

      if (activePath.size === 0) {
        const parentIds = new Set(Object.values(children).flat())
        const leaves = Object.keys(mapping).filter((id) => !children[id]?.length)
        cursor = leaves[leaves.length - 1] ?? roots[roots.length - 1] ?? ''
        while (cursor && mapping[cursor]) {
          activePath.add(cursor)
          cursor = mapping[cursor].parent ?? ''
        }
        if (activePath.size === 0) {
          parentIds.forEach((id) => activePath.add(id))
        }
      }

      // ── Step 3: DFS traversal — track depth and branch index ───────────────
      interface StackFrame { nodeId: string; depth: number; branchIndex: number }
      const stack: StackFrame[] = roots.map((r) => ({
        nodeId: r,
        depth: 0,
        branchIndex: 0,
      }))

      const pushChildren = (nodeId: string, depth: number) => {
        const kids = children[nodeId] ?? []
        kids.forEach((kid, i) =>
          stack.push({ nodeId: kid, depth: depth + 1, branchIndex: i })
        )
      }

      while (stack.length) {
        const { nodeId, depth, branchIndex } = stack.pop()!
        const node = mapping[nodeId]
        if (!node) continue

        const msg = node.message
        if (!msg) {
          pushChildren(nodeId, depth)
          continue
        }

        const role: string = msg.author?.role ?? 'unknown'

        if (role === 'system') {
          skipped++
          pushChildren(nodeId, depth)
          continue
        }

        // ── Extract content ──────────────────────────────────────────────────
        const { text, hasImage, hasAudio, codeBlocks, attachments, links } = extractContent(msg.content)

        // Also extract file attachments from metadata.attachments
        if (msg.metadata && Array.isArray(msg.metadata.attachments)) {
          for (const att of msg.metadata.attachments) {
            if (!att) continue
            const mime = att.mime_type ?? ''
            if (mime && !mime.startsWith('image/')) {
              attachments.push({
                type: 'file',
                asset_pointer: att.id ?? null,
                name: att.name ?? att.file_name ?? null,
                mime_type: mime,
                size_bytes: att.size ?? null,
              })
            }
          }
        }

        if (!text && !hasImage && !hasAudio && codeBlocks.length === 0) {
          skipped++
          pushChildren(nodeId, depth)
          continue
        }

        const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0
        const langs = [...new Set(codeBlocks.map((c) => c.lang).filter(Boolean))]
        const msgId = msg.id ?? nodeId

        insertMsg.run({
          id: msgId,
          conv_id: convId,
          parent_id: node.parent ?? null,
          role,
          text,
          word_count: wordCount,
          has_code: codeBlocks.length > 0 ? 1 : 0,
          has_image: hasImage ? 1 : 0,
          has_audio: hasAudio ? 1 : 0,
          code_langs: langs.length ? JSON.stringify(langs) : null,
          create_time: msg.create_time ?? null,
          model: msg.metadata?.model_slug ?? null,
          finish_reason: msg.metadata?.finish_details?.type ?? null,
          branch_index: branchIndex,
          is_active_branch: activePath.has(nodeId) ? 1 : 0,
          depth,
        })

        codeBlocks.forEach((cb, i) => {
          insertCode.run({
            message_id: msgId,
            lang: cb.lang,
            code: cb.code,
            position: i,
          })
        })

        attachments.forEach((att) => {
          insertAttachment.run({
            message_id: msgId,
            conv_id: convId,
            type: att.type,
            asset_pointer: att.asset_pointer ?? null,
            name: att.name ?? null,
            mime_type: att.mime_type ?? null,
            width: att.width ?? null,
            height: att.height ?? null,
            size_bytes: att.size_bytes ?? null,
          })
        })

        links.forEach((link) => {
          insertLink.run({
            message_id: msgId,
            conv_id: convId,
            url: link.url,
            domain: link.domain,
            title: link.title ?? null,
          })
        })

        // Memory writes: assistant messages sent to the "bio" tool
        if (msg.recipient === 'bio' && text) {
          insertMemory.run({
            message_id: msgId,
            conv_id: convId,
            text,
            create_time: msg.create_time ?? null,
          })
        }

        totalMessages++
        pushChildren(nodeId, depth)
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

// ── Content extraction ────────────────────────────────────────────────────────

interface CodeBlock { lang: string; code: string }
interface AttachmentMeta {
  type: string
  asset_pointer?: string | null
  name?: string | null
  mime_type?: string | null
  width?: number | null
  height?: number | null
  size_bytes?: number | null
}
interface LinkMeta { url: string; domain: string; title: string | null }
interface Extracted {
  text: string
  hasImage: boolean
  hasAudio: boolean
  codeBlocks: CodeBlock[]
  attachments: AttachmentMeta[]
  links: LinkMeta[]
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g
const URL_RE = /https?:\/\/[^\s<>"')\]},;]+/g

function extractLinks(text: string): LinkMeta[] {
  if (!text) return []
  const stripped = text.replace(CODE_FENCE_RE, '')
  const seen = new Set<string>()
  const links: LinkMeta[] = []
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(stripped)) !== null) {
    let url = m[0].replace(/[.)]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    let domain = ''
    try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { domain = '' }
    links.push({ url, domain, title: null })
  }
  return links
}

function extractContent(content: any): Extracted {
  let text = ''
  let hasImage = false
  let hasAudio = false
  const attachments: AttachmentMeta[] = []

  if (!content) return { text, hasImage, hasAudio, codeBlocks: [], attachments, links: [] }

  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content.parts)) {
    const textParts: string[] = []
    for (const part of content.parts) {
      if (typeof part === 'string') {
        textParts.push(part)
      } else if (part && typeof part === 'object') {
        const ct: string = part.content_type ?? ''
        if (ct === 'image_asset_pointer' || ct === 'image' || part.asset_pointer || part.fovea_id) {
          hasImage = true
          attachments.push({
            type: 'image',
            asset_pointer: part.asset_pointer ?? null,
            width: part.width ?? null,
            height: part.height ?? null,
            size_bytes: part.size_bytes ?? null,
          })
        } else if (ct === 'audio_asset_pointer' || ct === 'audio' || ct === 'audio_transcription') {
          hasAudio = true
          if (typeof part.text === 'string' && part.text.trim()) textParts.push(part.text)
          if (typeof part.transcription === 'string' && part.transcription.trim()) textParts.push(part.transcription)
          if (typeof part.word_transcription === 'string' && part.word_transcription.trim()) {
            textParts.push(part.word_transcription)
          }
        } else if (ct === 'real_time_user_audio_video_asset_pointer') {
          hasAudio = true
          const nestedAudio = part.audio_asset_pointer
          if (nestedAudio && typeof nestedAudio === 'object') {
            const nestedMeta = nestedAudio.metadata
            if (typeof nestedMeta?.transcription === 'string' && nestedMeta.transcription.trim()) {
              textParts.push(nestedMeta.transcription)
            }
            if (typeof nestedMeta?.word_transcription === 'string' && nestedMeta.word_transcription.trim()) {
              textParts.push(nestedMeta.word_transcription)
            }
          }
        } else if (ct === 'file' || ct === 'document' || (part.name && part.mime_type)) {
          attachments.push({
            type: 'file',
            asset_pointer: part.asset_pointer ?? null,
            name: part.name ?? null,
            mime_type: part.mime_type ?? null,
            size_bytes: part.size_bytes ?? null,
          })
        } else if (ct === 'tether_quote' || ct === 'tether_browsing_display') {
          if (part.result) textParts.push(String(part.result))
          if (part.title) textParts.push('[browsed: ' + part.title + ']')
        } else if (ct === 'code' && part.text) {
          textParts.push('```' + (part.language ?? '') + '\n' + part.text + '\n```')
        } else if (part.text) {
          textParts.push(String(part.text))
        } else if (typeof part.transcription === 'string') {
          textParts.push(part.transcription)
        }
      }
    }
    text = textParts.join('\n').trim()
  } else if (typeof content.text === 'string') {
    text = content.text
  }

  const codeBlocks: CodeBlock[] = []
  let match: RegExpExecArray | null
  CODE_FENCE_RE.lastIndex = 0
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: match[1].trim() || 'text', code: match[2].trim() })
  }

  const links = extractLinks(text)

  return { text, hasImage, hasAudio, codeBlocks, attachments, links }
}

function normalizeConversations(data: unknown): any[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []

  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.conversations)) return obj.conversations as any[]
  if (Array.isArray(obj.data)) return obj.data as any[]
  if (Array.isArray(obj.items)) return obj.items as any[]
  if ('mapping' in obj || 'current_node' in obj) return [obj]

  return []
}
