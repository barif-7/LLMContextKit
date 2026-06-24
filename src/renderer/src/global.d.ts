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
      openFileForMerge: () => Promise<string[] | null>
      mergeImport: (paths: string[]) => Promise<{ ok: boolean; error?: string; conversations?: number; messages?: number }>

      search: (params: SearchParams) => Promise<import('./App').Message[]>
      stats: () => Promise<import('./App').Stats>
      searchCodeBlocks: (params: CodeSearchParams) => Promise<any[]>
      codeLangs: () => Promise<Array<{ lang: string; count: number }>>

      conversations: () => Promise<import('./App').Conversation[]>
      messageContext: (id: string) => Promise<any[]>
      messagesByConversation: (convId: string) => Promise<any[]>
      codeBlocks: (id: string) => Promise<any[]>
      listAttachments: (type: string) => Promise<any[]>
      listLinks: () => Promise<any[]>
      listMemories: () => Promise<any[]>
      claudeProjects: () => Promise<Array<{ project_name: string; message_count: number }>>
      claudeDesignProjects: () => Promise<import('./App').ClaudeDesignProject[]>
      claudeDesignFiles: (params: {
        projectName?: string
        operation?: string
        filePath?: string
        query?: string
        limit?: number
        offset?: number
      }) => Promise<import('./App').ClaudeDesignFile[]>
      claudeFileTree: (params: {
        projectName?: string
        query?: string
        limit?: number
      }) => Promise<import('./App').ClaudeFileTreeItem[]>
      clearDB: () => Promise<{ ok: boolean }>

      openExternal: (url: string) => Promise<void>

      searchFlags: () => Promise<import('./App').SearchFlags>
      setSearchFlags: (patch: Partial<import('./App').SearchFlags>) => Promise<import('./App').SearchFlags>
      searchFiles: (params: { query?: string; limit?: number; offset?: number }) => Promise<import('./App').FileSearchResult[]>

      syncFlags: () => Promise<import('./App').SyncFlags>
      setSyncFlags: (patch: Partial<import('./App').SyncFlags>) => Promise<import('./App').SyncFlags>
      syncStatus: () => Promise<{ flags: import('./App').SyncFlags; activeRun: { mode: string; startedAt: number } | null }>
      startChatGPTAuth: () => Promise<{
        ok: boolean
        mode: string
        message?: string
        error?: string
      }>
      chatGPTAuthStatus: () => Promise<import('./App').ChatGPTAuthStatus>
      runSync: (mode: 'chatgpt-extension' | 'chatgpt-native' | 'claude-native') => Promise<{
        ok: boolean
        mode: string
        message?: string
        listeners?: number
        stdout?: string
        stderr?: string
        exitCode?: number
        error?: string
      }>

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
    source?: string
    claudeKind?: string
    projectName?: string
    hasToolCall?: boolean
    filePathContains?: string
    limit?: number
    offset?: number
  }

  interface CodeSearchParams {
    query?: string
    langs?: string[]
    limit?: number
    offset?: number
  }
}
