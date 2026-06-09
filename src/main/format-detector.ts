export type ExportFormat = 'chatgpt' | 'claude' | 'unknown'

export function detectFormat(data: unknown): ExportFormat {
  const first = firstConversation(data)
  if (!first || typeof first !== 'object') return 'unknown'

  if ('mapping' in first || 'current_node' in first || 'conversation_id' in first) return 'chatgpt'
  if ('chat_messages' in first) return 'claude'
  if ('uuid' in first && ('name' in first || 'chat_messages' in first)) return 'claude'
  // design_chat format: individual conversation with `messages` array and `project`
  if ('messages' in first && ('title' in first || 'project' in first)) return 'claude'

  return 'unknown'
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
