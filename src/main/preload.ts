import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // File
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  importFile: (path: string) => ipcRenderer.invoke('import:file', path),
  onImportProgress: (cb: (p: any) => void) => {
    ipcRenderer.on('import:progress', (_e, p) => cb(p))
    return () => ipcRenderer.removeAllListeners('import:progress')
  },
  openFileForMerge: () => ipcRenderer.invoke('dialog:openFileForMerge'),
  mergeImport: (paths: string[]) => ipcRenderer.invoke('import:merge', paths),

  // Search
  search: (params: any) => ipcRenderer.invoke('search:query', params),
  stats: () => ipcRenderer.invoke('search:stats'),
  searchCodeBlocks: (params: any) => ipcRenderer.invoke('search:codeblocks', params),
  codeLangs: () => ipcRenderer.invoke('search:codeLangs'),

  // Data
  conversations: () => ipcRenderer.invoke('conversations:list'),
  messageContext: (id: string) => ipcRenderer.invoke('messages:context', id),
  messagesByConversation: (convId: string) => ipcRenderer.invoke('messages:byConversation', convId),
  codeBlocks: (id: string) => ipcRenderer.invoke('messages:codeblocks', id),
  listAttachments: (type: string) => ipcRenderer.invoke('attachments:list', type),
  listLinks: () => ipcRenderer.invoke('links:list'),
  listMemories: () => ipcRenderer.invoke('memories:list'),
  clearDB: () => ipcRenderer.invoke('db:clear'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Search
  searchFlags: () => ipcRenderer.invoke('search:flags:get'),
  setSearchFlags: (patch: any) => ipcRenderer.invoke('search:flags:set', patch),
  searchFiles: (params: any) => ipcRenderer.invoke('search:files', params),

  // Sync
  syncFlags: () => ipcRenderer.invoke('sync:flags:get'),
  setSyncFlags: (patch: any) => ipcRenderer.invoke('sync:flags:set', patch),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  runSync: (mode: string) => ipcRenderer.invoke('sync:run', mode),

  // MCP
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  installClaudeMcp: () => ipcRenderer.invoke('mcp:installClaude'),
  showMcpConfig: () => ipcRenderer.invoke('mcp:showConfig'),
})
