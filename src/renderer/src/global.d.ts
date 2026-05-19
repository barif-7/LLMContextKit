export {}

declare global {
  interface Window {
    api: {
      openFile: () => Promise<string | null>
      getPathForFile: (file: File) => string
      importFile: (path: string) => Promise<{
        ok: boolean
        error?: string
        conversations?: number
        messages?: number
        skipped?: number
        durationMs?: number
      }>
      onImportProgress: (cb: (p: { done: number; total: number; phase: string }) => void) => () => void

      search: (params: SearchParams) => Promise<import('./App').Message[]>
      stats: () => Promise<import('./App').Stats>

      conversations: () => Promise<import('./App').Conversation[]>
      messageContext: (id: string) => Promise<any[]>
      codeBlocks: (id: string) => Promise<any[]>
      clearDB: () => Promise<{ ok: boolean }>

      mcpStatus: () => Promise<import('./components/McpPanel').McpStatus>
      installClaudeMcp: () => Promise<{ ok: boolean; configPath?: string; error?: string }>
      showMcpConfig: () => Promise<{ ok: boolean }>
    }
  }

  interface SearchParams {
    query?: string
    convId?: string
    role?: string
    hasCode?: boolean
    hasImage?: boolean
    isLong?: boolean
    activeBranchOnly?: boolean
    sort?: string
  }
}
