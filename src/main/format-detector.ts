export type ExportFormat = 'chatgpt' | 'claude' | 'unknown'

export function detectFormat(data: unknown): ExportFormat {
  if (!Array.isArray(data) || data.length === 0) return 'unknown'

  const first = data[0]
  if (first && typeof first === 'object') {
    if ('mapping' in first && 'current_node' in first) return 'chatgpt'
    if ('chat_messages' in first && 'uuid' in first && 'name' in first) return 'claude'
  }

  return 'unknown'
}
