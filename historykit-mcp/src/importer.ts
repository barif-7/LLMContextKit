import type Database from 'better-sqlite3'

interface CodeBlock {
  lang: string
  code: string
}

interface AttachmentMeta {
  type: string
  asset_pointer?: string | null
  name?: string | null
  mime_type?: string | null
  width?: number | null
  height?: number | null
  size_bytes?: number | null
  extracted_content?: string | null
}

interface PendingFileContentTarget {
  message_id: string
  file_name?: string | null
  file_type?: string | null
  file_size?: number | null
}

interface LinkMeta {
  url: string
  domain: string
  title: string | null
}

interface ContentExtraction {
  text: string
  hasImage: boolean
  hasAudio: boolean
  codeBlocks: CodeBlock[]
  attachments: AttachmentMeta[]
  links: LinkMeta[]
}

export interface ImportResult {
  new_count: number
  updated_count: number
  skipped_count: number
  errored_count: number
  message_count: number
  code_block_count: number
  attachment_count: number
  file_content_count: number
  link_count: number
  memory_count: number
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

export interface ImportOptions {
  force?: boolean
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g
const URL_RE = /https?:\/\/[^\s<>"')\]},;]+/g

function toUnixSeconds(value: unknown): number | null {
  if (value == null || value === '') return null

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 1_000_000_000_000 ? value / 1000 : value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric
    }

    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed / 1000 : null
  }

  return null
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
    try {
      domain = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      domain = ''
    }

    links.push({ url, domain, title: null })
  }

  return links
}

function extractContent(content: any): ContentExtraction {
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
        if (ct === 'file' || ct === 'document' || (part.name && part.mime_type)) {
          const extractedContent = extractAttachmentText(part)
          attachments.push({
            type: 'file',
            asset_pointer: part.asset_pointer ?? null,
            name: part.name ?? null,
            mime_type: part.mime_type ?? null,
            size_bytes: part.size_bytes ?? null,
            extracted_content: extractedContent,
          })
        } else if (ct === 'image_asset_pointer' || ct === 'image' || part.asset_pointer || part.fovea_id) {
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
          if (typeof part.transcription === 'string' && part.transcription.trim()) {
            textParts.push(part.transcription)
          }
          if (typeof part.word_transcription === 'string' && part.word_transcription.trim()) {
            textParts.push(part.word_transcription)
          }
        } else if (ct === 'real_time_user_audio_video_asset_pointer') {
          hasAudio = true
          const nestedAudio = part.audio_asset_pointer
          const nestedMeta = nestedAudio && typeof nestedAudio === 'object'
            ? nestedAudio.metadata
            : null
          if (typeof nestedMeta?.transcription === 'string' && nestedMeta.transcription.trim()) {
            textParts.push(nestedMeta.transcription)
          }
          if (typeof nestedMeta?.word_transcription === 'string' && nestedMeta.word_transcription.trim()) {
            textParts.push(nestedMeta.word_transcription)
          }
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

  return { text, hasImage, hasAudio, codeBlocks, attachments, links: extractLinks(text) }
}

function extractAttachmentText(value: any): string | null {
  if (!value || typeof value !== 'object') return null

  const candidates = [
    value.extracted_content,
    value.text,
    value.content,
    value.contents,
    value.file_content,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }

  return null
}

function isFileContentToolMessage(role: string, text: string): boolean {
  if (role !== 'tool' || !text.trim()) return false
  if (/^All the files uploaded/i.test(text)) return false
  if (text === 'Model set context updated.') return false
  return true
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name)
}

export function ensureFtsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_blocks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id),
      lang       TEXT NOT NULL DEFAULT '',
      code       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_code_message ON code_blocks(message_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      conv_id       TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'image',
      asset_pointer TEXT,
      name          TEXT,
      mime_type     TEXT,
      width         INTEGER,
      height        INTEGER,
      size_bytes    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conv_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_type ON attachments(type);

    CREATE TABLE IF NOT EXISTS links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      conv_id       TEXT NOT NULL,
      url           TEXT NOT NULL,
      domain        TEXT,
      title         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_links_conv   ON links(conv_id);
    CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);

    CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      conv_id       TEXT NOT NULL,
      text          TEXT NOT NULL,
      create_time   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conv_id);
    CREATE INDEX IF NOT EXISTS idx_memories_time ON memories(create_time DESC);

    CREATE TABLE IF NOT EXISTS attachment_contents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  TEXT NOT NULL,
      file_name   TEXT,
      file_type   TEXT,
      file_size   INTEGER,
      content     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_att_content_msg ON attachment_contents(message_id);

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

    CREATE VIRTUAL TABLE IF NOT EXISTS attachment_contents_fts USING fts5(
      content,
      file_name,
      content=attachment_contents,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `)
}

export function getKnownIds(db: Database.Database): Record<string, number | null> {
  const rows = db.prepare(
    "SELECT id, update_time FROM conversations WHERE source = 'chatgpt'"
  ).all() as Array<{ id: string; update_time: unknown }>
  const result: Record<string, number | null> = {}
  for (const row of rows) {
    result[row.id] = toUnixSeconds(row.update_time)
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
  conversations: any[],
  options: ImportOptions = {}
): ImportResult {
  const result: ImportResult = {
    new_count: 0,
    updated_count: 0,
    skipped_count: 0,
    errored_count: 0,
    message_count: 0,
    code_block_count: 0,
    attachment_count: 0,
    file_content_count: 0,
    link_count: 0,
    memory_count: 0,
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
  const deleteAttachmentContentsForConv = db.prepare(
    'DELETE FROM attachment_contents WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)'
  )
  const hasAttachmentsTable = tableExists(db, 'attachments')
  const deleteAttachmentsMetaForConv = hasAttachmentsTable
    ? db.prepare('DELETE FROM attachments WHERE conv_id = ?')
    : null
  const hasLinksTable = tableExists(db, 'links')
  const deleteLinksForConv = hasLinksTable
    ? db.prepare('DELETE FROM links WHERE conv_id = ?')
    : null
  const hasMemoriesTable = tableExists(db, 'memories')
  const deleteMemoriesForConv = hasMemoriesTable
    ? db.prepare('DELETE FROM memories WHERE conv_id = ?')
    : null
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

  const insertAttachment = hasAttachmentsTable
    ? db.prepare(`
        INSERT INTO attachments
          (message_id, conv_id, type, asset_pointer, name, mime_type, width, height, size_bytes)
        VALUES
          (@message_id, @conv_id, @type, @asset_pointer, @name, @mime_type, @width, @height, @size_bytes)
      `)
    : null

  const insertLink = hasLinksTable
    ? db.prepare(`
        INSERT INTO links (message_id, conv_id, url, domain, title)
        VALUES (@message_id, @conv_id, @url, @domain, @title)
      `)
    : null

  const insertMemory = hasMemoriesTable
    ? db.prepare(`
        INSERT INTO memories (message_id, conv_id, text, create_time)
        VALUES (@message_id, @conv_id, @text, @create_time)
      `)
    : null

  const hasAttachmentContentsTable = tableExists(db, 'attachment_contents')
  const insertAttachmentContent = hasAttachmentContentsTable
    ? db.prepare(`
        INSERT INTO attachment_contents (message_id, file_name, file_type, file_size, content)
        VALUES (@message_id, @file_name, @file_type, @file_size, @content)
      `)
    : null

  const processConversation = db.transaction((conv: any) => {
    const convId: string = conv.id ?? conv.conversation_id
    if (!convId) throw new Error('Conversation missing id')

    const existing = getConv.get(convId) as any
    const existingUpdateTime = toUnixSeconds(existing?.update_time)
    const incomingUpdateTime = toUnixSeconds(conv.update_time)

    if (!options.force && existing && existingUpdateTime != null && incomingUpdateTime != null) {
      if (existingUpdateTime >= incomingUpdateTime) {
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
      deleteAttachmentContentsForConv.run(convId)
      if (deleteAttachmentsMetaForConv) deleteAttachmentsMetaForConv.run(convId)
      if (deleteLinksForConv) deleteLinksForConv.run(convId)
      if (deleteMemoriesForConv) deleteMemoriesForConv.run(convId)
      deleteMessagesForConv.run(convId)
    }

    upsertConv.run({
      id: convId,
      title: convTitle,
      create_time: toUnixSeconds(conv.create_time),
      update_time: incomingUpdateTime,
      current_node: currentNode,
    })

    // Walk the mapping tree — identical logic to parser.ts
    const children: Record<string, string[]> = {}
    for (const nodeId of Object.keys(mapping)) {
      const parent = mapping[nodeId]?.parent
      if (parent) {
        if (!children[parent]) children[parent] = []
        children[parent].push(nodeId)
      }
    }

    const roots = Object.keys(mapping).filter(
      (id) => !mapping[id]?.parent || !mapping[mapping[id].parent]
    )

    // activePath doubles as the visited set: a parent-pointer cycle in a
    // malformed export would otherwise loop forever and hang the daemon.
    const activePath = new Set<string>()
    let cursor = currentNode
    while (cursor && mapping[cursor] && !activePath.has(cursor)) {
      activePath.add(cursor)
      cursor = mapping[cursor].parent ?? ''
    }

    if (activePath.size === 0) {
      const leaves = Object.keys(mapping).filter((id) => !children[id]?.length)
      cursor = leaves[leaves.length - 1] ?? roots[roots.length - 1] ?? ''
      while (cursor && mapping[cursor] && !activePath.has(cursor)) {
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
    let pendingFileContentTargets: PendingFileContentTarget[] = []

    const visited = new Set<string>()
    while (stack.length) {
      const { nodeId, depth, branchIndex } = stack.pop()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
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

      const { text, hasImage, hasAudio, codeBlocks, attachments, links } = extractContent(msg.content)

      if (msg.metadata && Array.isArray(msg.metadata.attachments)) {
        for (const attachment of msg.metadata.attachments) {
          if (!attachment) continue
          const mimeType = attachment.mime_type ?? ''
          if (mimeType && !mimeType.startsWith('image/')) {
            attachments.push({
              type: 'file',
              asset_pointer: attachment.id ?? null,
              name: attachment.name ?? attachment.file_name ?? null,
              mime_type: mimeType,
              size_bytes: attachment.size ?? null,
              extracted_content: extractAttachmentText(attachment),
            })
          }
        }
      }

      if (!text && !hasImage && !hasAudio && codeBlocks.length === 0 && attachments.length === 0) {
        pushChildren(nodeId, depth)
        continue
      }

      const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0
      const langs = [...new Set(codeBlocks.map((c) => c.lang).filter(Boolean))]
      const msgId = msg.id ?? nodeId
      const msgCreateTime = toUnixSeconds(msg.create_time)

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
        create_time: msgCreateTime,
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
        result.code_block_count++
      })

      if (insertAttachment) {
        attachments.forEach((attachment) => {
          insertAttachment.run({
            message_id: msgId,
            conv_id: convId,
            type: attachment.type,
            asset_pointer: attachment.asset_pointer ?? null,
            name: attachment.name ?? null,
            mime_type: attachment.mime_type ?? null,
            width: attachment.width ?? null,
            height: attachment.height ?? null,
            size_bytes: attachment.size_bytes ?? null,
          })
          result.attachment_count++
        })
      }

      if (insertAttachmentContent) {
        attachments.forEach((attachment) => {
          if (attachment.type !== 'file') return
          if (attachment.extracted_content?.trim()) {
            insertAttachmentContent.run({
              message_id: msgId,
              file_name: attachment.name ?? null,
              file_type: attachment.mime_type ?? null,
              file_size: attachment.size_bytes ?? null,
              content: attachment.extracted_content,
            })
            result.file_content_count++
          } else if (role === 'user') {
            pendingFileContentTargets.push({
              message_id: msgId,
              file_name: attachment.name ?? null,
              file_type: attachment.mime_type ?? null,
              file_size: attachment.size_bytes ?? null,
            })
          }
        })
      }

      if (insertLink) {
        links.forEach((link) => {
          insertLink.run({
            message_id: msgId,
            conv_id: convId,
            url: link.url,
            domain: link.domain,
            title: link.title ?? null,
          })
          result.link_count++
        })
      }

      if (insertMemory && msg.recipient === 'bio' && text) {
        insertMemory.run({
          message_id: msgId,
          conv_id: convId,
          text,
          create_time: msgCreateTime,
        })
        result.memory_count++
      }

      if (insertAttachmentContent && isFileContentToolMessage(role, text) && pendingFileContentTargets.length > 0) {
        const attachment = pendingFileContentTargets.shift()!
        insertAttachmentContent.run({
          message_id: attachment.message_id,
          file_name: attachment.file_name ?? null,
          file_type: attachment.file_type ?? null,
          file_size: attachment.file_size ?? null,
          content: text,
        })
        result.file_content_count++
      }

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

  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  if (tableExists(db, 'attachment_contents_fts')) {
    db.exec(`INSERT INTO attachment_contents_fts(attachment_contents_fts) VALUES('rebuild')`)
  }

  return result
}
