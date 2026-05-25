import type Database from 'better-sqlite3'

interface CodeBlock {
  lang: string
  code: string
}

interface ContentExtraction {
  text: string
  hasImage: boolean
  hasAudio: boolean
  codeBlocks: CodeBlock[]
}

export interface ImportResult {
  new_count: number
  updated_count: number
  skipped_count: number
  errored_count: number
  message_count: number
  errors: string[]
}

export interface DbStatus {
  conversations: number
  messages: number
  code_blocks: number
  latest_message_time: number | null
  days_stale: number | null
  has_embeddings: boolean
  embedded_count: number
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g

function extractContent(content: any): ContentExtraction {
  let text = ''
  let hasImage = false
  let hasAudio = false

  if (!content) return { text, hasImage, hasAudio, codeBlocks: [] }

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
        } else if (ct === 'audio_asset_pointer' || ct === 'audio') {
          hasAudio = true
        } else if (ct === 'tether_quote' || ct === 'tether_browsing_display') {
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
  } else if (typeof content.text === 'string') {
    text = content.text
  }

  const codeBlocks: CodeBlock[] = []
  let match: RegExpExecArray | null
  CODE_FENCE_RE.lastIndex = 0
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: match[1].trim() || 'text', code: match[2].trim() })
  }

  return { text, hasImage, hasAudio, codeBlocks }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name)
}

export function ensureFtsSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content=messages,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `)
}

export function getKnownIds(db: Database.Database): Record<string, number | null> {
  const rows = db.prepare(
    "SELECT id, update_time FROM conversations WHERE source = 'chatgpt'"
  ).all() as Array<{ id: string; update_time: number | null }>
  const result: Record<string, number | null> = {}
  for (const row of rows) {
    result[row.id] = row.update_time
  }
  return result
}

export function getDbStatus(db: Database.Database): DbStatus {
  const convCount = (db.prepare('SELECT COUNT(*) as n FROM conversations').get() as any).n
  const msgCount = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as any).n
  const codeCount = (db.prepare('SELECT COUNT(*) as n FROM code_blocks').get() as any).n
  const latest = db.prepare(
    'SELECT MAX(create_time) as max_time FROM messages WHERE create_time > 0'
  ).get() as any
  const latestTime: number | null = latest?.max_time ?? null
  const daysStale =
    latestTime != null ? Math.floor((Date.now() / 1000 - latestTime) / 86400) : null

  const hasEmbeddings = tableExists(db, 'message_embeddings')
  const embeddedCount = hasEmbeddings
    ? (db.prepare('SELECT COUNT(*) as n FROM message_embeddings').get() as any).n
    : 0

  return {
    conversations: convCount,
    messages: msgCount,
    code_blocks: codeCount,
    latest_message_time: latestTime,
    days_stale: daysStale,
    has_embeddings: hasEmbeddings,
    embedded_count: embeddedCount,
  }
}

export function upsertConversations(
  db: Database.Database,
  conversations: any[]
): ImportResult {
  const result: ImportResult = {
    new_count: 0,
    updated_count: 0,
    skipped_count: 0,
    errored_count: 0,
    message_count: 0,
    errors: [],
  }

  if (!conversations || conversations.length === 0) return result

  const getConv = db.prepare('SELECT id, update_time FROM conversations WHERE id = ?')

  const upsertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES (@id, @title, @create_time, @update_time, @current_node, 'chatgpt')
  `)

  const deleteCodeBlocksForConv = db.prepare(
    'DELETE FROM code_blocks WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)'
  )
  const deleteAttachmentsForConv = db.prepare(
    'DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)'
  )
  const deleteMessagesForConv = db.prepare('DELETE FROM messages WHERE conv_id = ?')

  const hasEmbeddings = tableExists(db, 'message_embeddings')
  const deleteEmbeddingsForConv = hasEmbeddings
    ? db.prepare('DELETE FROM message_embeddings WHERE conversation_id = ?')
    : null

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

  const processConversation = db.transaction((conv: any) => {
    const convId: string = conv.id ?? conv.conversation_id
    if (!convId) throw new Error('Conversation missing id')

    const existing = getConv.get(convId) as any
    const incomingUpdateTime: number | null = conv.update_time ?? null

    if (existing && existing.update_time != null && incomingUpdateTime != null) {
      if (existing.update_time >= incomingUpdateTime) {
        result.skipped_count++
        return
      }
    }

    const isNew = !existing
    const convTitle: string = conv.title || 'Untitled conversation'
    const currentNode: string = conv.current_node ?? ''
    const mapping: Record<string, any> = conv.mapping ?? {}

    if (!isNew) {
      if (deleteEmbeddingsForConv) deleteEmbeddingsForConv.run(convId)
      deleteCodeBlocksForConv.run(convId)
      deleteAttachmentsForConv.run(convId)
      deleteMessagesForConv.run(convId)
    }

    upsertConv.run({
      id: convId,
      title: convTitle,
      create_time: conv.create_time ?? null,
      update_time: incomingUpdateTime,
      current_node: currentNode,
    })

    // Walk the mapping tree — identical logic to parser.ts
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

    const activePath = new Set<string>()
    let cursor = currentNode
    while (cursor && mapping[cursor]) {
      activePath.add(cursor)
      cursor = mapping[cursor].parent ?? ''
    }

    if (activePath.size === 0) {
      const leaves = Object.keys(mapping).filter((id) => !children[id]?.length)
      cursor = leaves[leaves.length - 1] ?? roots[roots.length - 1] ?? ''
      while (cursor && mapping[cursor]) {
        activePath.add(cursor)
        cursor = mapping[cursor].parent ?? ''
      }
    }

    interface StackFrame {
      nodeId: string
      depth: number
      branchIndex: number
    }
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

    let convMessageCount = 0

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
        pushChildren(nodeId, depth)
        continue
      }

      const { text, hasImage, hasAudio, codeBlocks } = extractContent(msg.content)

      if (!text && !hasImage && !hasAudio && codeBlocks.length === 0) {
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

      convMessageCount++
      pushChildren(nodeId, depth)
    }

    result.message_count += convMessageCount
    if (isNew) result.new_count++
    else result.updated_count++
  })

  for (const conv of conversations) {
    try {
      processConversation(conv)
    } catch (err: any) {
      result.errored_count++
      result.errors.push(`${conv?.id ?? 'unknown'}: ${err.message}`)
      process.stderr.write(
        `[historykit] import error for ${conv?.id ?? 'unknown'}: ${err.stack ?? err.message}\n`
      )
    }
  }

  return result
}
