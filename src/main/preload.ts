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

  // Search
  search: (params: any) => ipcRenderer.invoke('search:query', params),
  stats: () => ipcRenderer.invoke('search:stats'),

  // Data
  conversations: () => ipcRenderer.invoke('conversations:list'),
  messageContext: (id: string) => ipcRenderer.invoke('messages:context', id),
  codeBlocks: (id: string) => ipcRenderer.invoke('messages:codeblocks', id),
  clearDB: () => ipcRenderer.invoke('db:clear'),

  // MCP
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  installClaudeMcp: () => ipcRenderer.invoke('mcp:installClaude'),
  showMcpConfig: () => ipcRenderer.invoke('mcp:showConfig'),
})
