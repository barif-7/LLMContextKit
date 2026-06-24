export type ExportFormat = 'chatgpt' | 'claude' | 'unknown'

export type ClaudeKind = 'conversations' | 'design_chat' | 'project' | 'memory'

export type ExportClassification =
  | { source: 'chatgpt'; kind: 'conversations' }
  | { source: 'claude'; kind: ClaudeKind }
  | { source: 'unknown'; kind: 'unknown' }

/**
 * Classify a parsed export into a (source, kind) pair. This is the single
 * source of truth for format detection — both the simple `detectFormat` helper
 * and the folder-import manifest build on top of it.
 */
export function classifyExport(data: unknown): ExportClassification {
  // Claude Memories export: array of { conversations_memory, account_uuid }
  if (isClaudeMemoriesExport(data)) return { source: 'claude', kind: 'memory' }

  // Claude Project export: object with a `docs` array
  if (isClaudeProjectExport(data)) return { source: 'claude', kind: 'project' }

  const first = firstConversation(data)
  if (!first || typeof first !== 'object') return { source: 'unknown', kind: 'unknown' }

  if ('mapping' in first || 'current_node' in first || 'conversation_id' in first) {
    return { source: 'chatgpt', kind: 'conversations' }
  }

  if ('chat_messages' in first) return { source: 'claude', kind: 'conversations' }
  if ('uuid' in first && ('name' in first || 'chat_messages' in first)) {
    return { source: 'claude', kind: 'conversations' }
  }
  // design_chat format: individual conversation with a `messages` array and `project`/`title`
  if ('messages' in first && ('title' in first || 'project' in first)) {
    return { source: 'claude', kind: 'design_chat' }
  }

  return { source: 'unknown', kind: 'unknown' }
}

export function detectFormat(data: unknown): ExportFormat {
  return classifyExport(data).source
}

export function isClaudeMemoriesExport(data: unknown): boolean {
  return Array.isArray(data) && data.some((item: any) => typeof item?.conversations_memory === 'string')
}

export function isClaudeProjectExport(data: unknown): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as any).docs)
}

function firstConversation(data: unknown): unknown {
  if (Array.isArray(data)) return data[0]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    // Skip non-conversation files (project definitions, user lists)
    if ('docs' in obj || 'is_starter_project' in obj) return null
    if (Array.isArray(obj.conversations)) return obj.conversations[0]
    if (Array.isArray(obj.data)) return obj.data[0]
    if (Array.isArray(obj.items)) return obj.items[0]
    return data
  }
  return null
}
