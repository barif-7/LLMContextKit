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

export async function parseConversations(
  data: unknown,
  onProgress?: ProgressCallback
): Promise<ParseResult> {
  const start = Date.now()
  const db = getDB()

  // Accept both array format and { conversations: [...] } wrapper
  const rawConvs: any[] = Array.isArray(data)
    ? data
    : (data as any)?.conversations ?? []

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

  // Clear existing data before reimport
  db.exec(`DELETE FROM attachment_contents; DELETE FROM code_blocks; DELETE FROM messages; DELETE FROM conversations;`)

  const importAll = db.transaction(() => {
    for (let ci = 0; ci < rawConvs.length; ci++) {
      const conv = rawConvs[ci]
      if (!conv || typeof conv !== 'object') continue

      const convId: string = conv.id ?? `conv_${ci}`
      const convTitle: string = conv.title || 'Untitled conversation'
      const currentNode: string = conv.current_node ?? ''

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

      // Find root(s): nodes with no parent
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

      // Some exports can omit current_node. Fall back to the deepest leaf so
      // default "active branch only" searches still show imported messages.
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
          // Null message node — still traverse children
          pushChildren(nodeId, depth)
          continue
        }

        const role: string = msg.author?.role ?? 'unknown'

        // Skip system and tool-scaffolding messages (keep tool *output* if it has text)
        if (role === 'system') {
          skipped++
          pushChildren(nodeId, depth)
          continue
        }

        // ── Extract content ──────────────────────────────────────────────────
        const { text, hasImage, hasAudio, codeBlocks } = extractContent(msg.content)

        // Skip totally empty messages
        if (!text && !hasImage && !hasAudio && codeBlocks.length === 0) {
          skipped++
          pushChildren(nodeId, depth)
          continue
        }

        const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0
        const langs = [...new Set(codeBlocks.map((c) => c.lang).filter(Boolean))]

        insertMsg.run({
          id: msg.id ?? nodeId,
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
            message_id: msg.id ?? nodeId,
            lang: cb.lang,
            code: cb.code,
            position: i,
          })
        })

        totalMessages++

        // Push children onto stack
        pushChildren(nodeId, depth)
      }

      onProgress?.({ done: ci + 1, total: rawConvs.length, phase: 'parsing' })
    }
  })

  importAll()

  // Rebuild FTS index after bulk insert (faster than trigger-per-row)
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
interface Extracted {
  text: string
  hasImage: boolean
  hasAudio: boolean
  codeBlocks: CodeBlock[]
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g

function extractContent(content: any): Extracted {
  let text = ''
  let hasImage = false
  let hasAudio = false

  if (!content) return { text, hasImage, hasAudio, codeBlocks: [] }

  // Simple string content (older format)
  if (typeof content === 'string') {
    text = content
  }
  // Structured content with parts array
  else if (Array.isArray(content.parts)) {
    const textParts: string[] = []
    for (const part of content.parts) {
      if (typeof part === 'string') {
        textParts.push(part)
      } else if (part && typeof part === 'object') {
        const ct: string = part.content_type ?? ''
        if (ct === 'image_asset_pointer' || ct === 'image' || part.asset_pointer || part.fovea_id) {
          hasImage = true
        } else if (ct === 'audio_asset_pointer' || ct === 'audio') {
          hasAudio = true
        } else if (ct === 'tether_quote' || ct === 'tether_browsing_display') {
          // Browsing tool output — include the title/text if present
          if (part.result) textParts.push(String(part.result))
          if (part.title) textParts.push('[browsed: ' + part.title + ']')
        } else if (ct === 'code' && part.text) {
          textParts.push('```' + (part.language ?? '') + '\n' + part.text + '\n```')
        } else if (part.text) {
          textParts.push(String(part.text))
        }
      }
    }
    text = textParts.join('\n').trim()
  }
  // Fallback: try .text field directly
  else if (typeof content.text === 'string') {
    text = content.text
  }

  // Extract code blocks from the assembled text
  const codeBlocks: CodeBlock[] = []
  let match: RegExpExecArray | null
  CODE_FENCE_RE.lastIndex = 0
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: match[1].trim() || 'text', code: match[2].trim() })
  }

  return { text, hasImage, hasAudio, codeBlocks }
}
