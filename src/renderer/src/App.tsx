import { useState, useEffect, useCallback, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { SearchBar } from './components/SearchBar'
import { ResultsList } from './components/ResultsList'
import { DetailPanel } from './components/DetailPanel'
import { ImportScreen } from './components/ImportScreen'
import { StatsBar } from './components/StatsBar'
import { McpPanel } from './components/McpPanel'
import { BrowseView } from './components/BrowseView'
import { ProfileView } from './components/ProfileView'
import { ConversationView } from './components/ConversationView'
import { SyncView } from './components/SyncView'
import { ClaudeDesignView } from './components/ClaudeDesignView'
import { ClaudeFileBrowser } from './components/ClaudeFileBrowser'
import styles from './App.module.css'

export type SearchScope = 'messages' | 'code' | 'files'
export type SortOrder = 'newest' | 'oldest' | 'longest' | 'relevance'
export type SourceFilter = 'all' | 'chatgpt' | 'claude'
export type ClaudeKindFilter = 'all' | 'conversations' | 'design_chat' | 'project' | 'memory'
export type AppView = 'search' | 'browse' | 'claudeDesign' | 'claudeFiles' | 'profile' | 'sync' | 'mcp'

export interface SearchFlags {
  restoreSearchResults: boolean
  semanticSearchSuite: boolean
}

export interface SyncFlags {
  browserExtensionChatGPT: boolean
  nativeChatGPT: boolean
  nativeClaude: boolean
}

export interface ChatGPTAuthStatus {
  debugPort: number
  chromeReachable: boolean
  hasChatGPTTarget: boolean
  authenticated: boolean
  hasAccessToken?: boolean
  user?: string | null
  title?: string
  url?: string
  message: string
}

export interface Message {
  id: string
  conv_id: string
  conv_title: string
  conv_updated: number
  role: string
  text: string
  word_count: number
  has_code: number
  has_image: number
  code_langs: string | null
  create_time: number | null
  model: string | null
  is_active_branch: number
  branch_index: number
  source: SourceFilter
}

export interface FileSearchResult extends Message {
  file_id: number
  file_name: string | null
  file_type: string | null
  file_size: number | null
  file_text: string
}

export interface Conversation {
  id: string
  title: string
  create_time: number
  update_time: number
  msg_count: number
}

export interface ClaudeDesignProject {
  project_uuid: string
  project_name: string
  file_events: number
  file_count: number
  conversation_count: number
  last_activity: number | null
}

export interface ClaudeDesignFile {
  id: number
  conv_id: string
  message_id: string
  project_uuid: string | null
  project_name: string | null
  file_path: string
  file_name: string | null
  file_type: string | null
  operation: string
  source_kind: string
  content: string | null
  hidden: number
  created_at: number | null
  conv_title: string | null
  conv_updated: number | null
  role: string | null
  message_text: string | null
}

export interface ClaudeFileTreeItem {
  project_name: string
  file_path: string
  file_name: string | null
  file_type: string | null
  last_activity: number | null
  event_count: number
  operations: string | null
}

export interface Stats {
  messages: number
  conversations: number
  withCode: number
  withImages: number
  totalWords: number
  withFiles: number
  withLinks: number
  withMemories: number
  bySource: {
    chatgpt: { messages: number; conversations: number }
    claude: { messages: number; conversations: number }
  }
}

export default function App() {
  const [hasData, setHasData] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 })
  const [importError, setImportError] = useState<string | null>(null)

  const [stats, setStats] = useState<Stats | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [results, setResults] = useState<Message[]>([])

  const [query, setQuery] = useState('')
  const [searchScope, setSearchScope] = useState<SearchScope>('messages')
  const [sort, setSort] = useState<SortOrder>('newest')
  const [activeBranchOnly, setActiveBranchOnly] = useState(true)
  const [source, setSource] = useState<SourceFilter>('all')
  const [claudeKind, setClaudeKind] = useState<ClaudeKindFilter>('all')
  const [claudeProject, setClaudeProject] = useState<string>('')
  const [claudeProjects, setClaudeProjects] = useState<Array<{ project_name: string; message_count: number }>>([])
  const [view, setView] = useState<AppView>('search')

  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null)
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [viewingConvId, setViewingConvId] = useState<string | null>(null)
  const [searchFlags, setSearchFlags] = useState<SearchFlags>({
    restoreSearchResults: true,
    semanticSearchSuite: false,
  })

  // Code search state
  const [codeResults, setCodeResults] = useState<any[]>([])
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [codeLangs, setCodeLangs] = useState<Array<{ lang: string; count: number }>>([])
  const [selectedLang, setSelectedLang] = useState<string | null>(null)

  const searchTimeout = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    checkForData()
    window.api.searchFlags().then(setSearchFlags).catch(() => {})
    window.api.claudeProjects().then(setClaudeProjects).catch(() => {})
  }, [])

  async function checkForData() {
    const s = await window.api.stats()
    if (s.messages > 0) {
      setStats(s)
      setHasData(true)
      loadConversations()
      doSearch({ q: '', sort: 'newest', activeBranchOnly: true, source: 'all' })
    }
  }

  async function refreshData() {
    const s = await window.api.stats()
    setStats(s)
    setHasData(s.messages > 0)
    loadConversations()
    doSearch({ q: query, sort, activeBranchOnly, source, claudeKind, claudeProject, convId: activeConvId })
  }

  async function loadConversations() {
    const convs = await window.api.conversations()
    setConversations(convs)
  }

  async function handleImport(filePath?: string) {
    setImportError(null)
    let path = filePath
    if (!path) {
      path = (await window.api.openFile()) ?? undefined
      if (!path) return
    }
    setImporting(true)
    const cleanup = window.api.onImportProgress((p: any) => setImportProgress(p))
    try {
      const result = await window.api.importFile(path)
      if (result.ok) {
        setHasData(true)
        const s = await window.api.stats()
        setStats(s)
        loadConversations()
        doSearch({ q: query, sort, activeBranchOnly, source, claudeKind, claudeProject })
      } else {
        setImportError(result.error || 'Import failed.')
      }
    } catch (err: any) {
      setImportError(err?.message || 'Import failed.')
    } finally {
      cleanup()
      setImporting(false)
    }
  }

  async function handleMergeImport() {
    setImportError(null)
    const paths = await window.api.openFileForMerge()
    if (!paths || paths.length === 0) return
    setImporting(true)
    const cleanup = window.api.onImportProgress((p: any) => setImportProgress(p))
    try {
      const result = await window.api.mergeImport(paths)
      if (result.ok) {
        const s = await window.api.stats()
        setStats(s)
        loadConversations()
        doSearch({ q: query, sort, activeBranchOnly, source, claudeKind, claudeProject })
      } else {
        setImportError(result.error || 'Merge failed.')
      }
    } catch (err: any) {
      setImportError(err?.message || 'Merge failed.')
    } finally {
      cleanup()
      setImporting(false)
    }
  }

  function handleFileImport(file: File) {
    setImportError(null)
    if (!file.name.endsWith('.json')) {
      setImportError('Choose a JSON file exported from ChatGPT or Claude.')
      return
    }
    const filePath = window.api.getPathForFile(file) || (file as any).path
    if (filePath) {
      handleImport(filePath)
    } else {
      setImportError('Could not read the selected file path. Try dragging the file into the window.')
    }
  }

  // Message search
  const doSearch = useCallback(async (params: {
    q: string; sort: SortOrder; activeBranchOnly: boolean; source: SourceFilter
    claudeKind?: ClaudeKindFilter; claudeProject?: string; convId?: string | null
  }) => {
    const searchParams: any = {
      query: params.q || undefined,
      sort: params.sort,
      activeBranchOnly: params.activeBranchOnly,
      source: params.source,
      convId: params.convId || undefined,
    }
    if (params.claudeKind && params.claudeKind !== 'all') searchParams.claudeKind = params.claudeKind
    if (params.claudeProject) searchParams.projectName = params.claudeProject
    const rows = await window.api.search(searchParams)
    setResults(rows)
  }, [])

  // Code search
  const doCodeSearch = useCallback(async (q: string, lang: string | null) => {
    const params: CodeSearchParams = { query: q || undefined, limit: 51 }
    if (lang) params.langs = [lang]
    const rows = await window.api.searchCodeBlocks(params)
    setCodeResults(rows)
  }, [])

  const doFileSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setFileResults([])
      return
    }
    const rows = await window.api.searchFiles({ query: q, limit: 200 })
    setFileResults(rows)
  }, [])

  function triggerSearch(overrides?: Partial<{ q: string; sort: SortOrder; activeBranchOnly: boolean; source: SourceFilter; claudeKind: ClaudeKindFilter; claudeProject: string; convId: string | null }>) {
    clearTimeout(searchTimeout.current)
    const params = { q: query, sort, activeBranchOnly, source, claudeKind, claudeProject, convId: activeConvId, ...overrides }
    searchTimeout.current = setTimeout(() => {
      if (searchScope === 'code') {
        doCodeSearch(params.q, selectedLang)
      } else if (searchScope === 'files') {
        doFileSearch(params.q)
      } else {
        doSearch(params)
      }
    }, overrides?.q !== undefined ? 120 : 0)
  }

  function onQueryChange(q: string) {
    setQuery(q)
    triggerSearch({ q })
  }

  function onSearchScopeChange(scope: SearchScope) {
    setSearchScope(scope)
    if (scope === 'code') {
      if (codeLangs.length === 0) window.api.codeLangs().then(setCodeLangs)
      doCodeSearch(query, selectedLang)
    } else if (scope === 'files') {
      doFileSearch(query)
    } else {
      doSearch({ q: query, sort, activeBranchOnly, source, claudeKind, claudeProject })
    }
  }

  function onLangChange(lang: string | null) {
    setSelectedLang(lang)
    doCodeSearch(query, lang)
  }

  function onSortChange(s: SortOrder) {
    setSort(s)
    triggerSearch({ sort: s })
  }

  function onSourceChange(s: SourceFilter) {
    setSource(s)
    // Claude-specific filters are meaningless for a ChatGPT-only view; clear them.
    if (s === 'chatgpt') {
      setClaudeKind('all')
      setClaudeProject('')
      triggerSearch({ source: s, claudeKind: 'all', claudeProject: '' })
    } else {
      triggerSearch({ source: s })
    }
  }

  function onClaudeKindChange(k: ClaudeKindFilter) {
    setClaudeKind(k)
    triggerSearch({ claudeKind: k })
  }

  function onClaudeProjectChange(p: string) {
    setClaudeProject(p)
    triggerSearch({ claudeProject: p })
  }

  function onBranchToggle() {
    const next = !activeBranchOnly
    setActiveBranchOnly(next)
    triggerSearch({ activeBranchOnly: next })
  }

  function onViewChange(v: AppView) {
    setView(v)
    setSelectedMsg(null)
    setActiveConvId(null)
    setViewingConvId(null)
  }

  function onConvSelect(id: string) {
    setViewingConvId(id)
    setSelectedMsg(null)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setImportError(null)
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.json')) {
      handleFileImport(file)
    } else {
      setImportError('Drop a JSON file exported from ChatGPT or Claude.')
    }
  }

  if (!hasData && !importing) {
    return (
      <ImportScreen
        onImport={() => handleImport()}
        onFileSelect={handleFileImport}
        onDrop={onDrop}
        error={importError}
      />
    )
  }

  if (importing) {
    return (
      <div className={styles.importingScreen}>
        <div className={styles.importSpinner} />
        <p>Parsing conversations…</p>
        {importProgress.total > 0 && (
          <span>{importProgress.done} / {importProgress.total}</span>
        )}
      </div>
    )
  }

  return (
    <div className={styles.root} onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <div className={`${styles.titlebar} drag-region`} />

      <div className={styles.layout}>
        <Sidebar
          activeView={view}
          stats={stats}
          onViewChange={onViewChange}
          onReimport={() => handleImport()}
          onMergeImport={handleMergeImport}
        />

        {viewingConvId ? (
          <ConversationView
            convId={viewingConvId}
            onBack={() => setViewingConvId(null)}
          />
        ) : view === 'mcp' ? (
          <McpPanel />
        ) : view === 'sync' ? (
          <SyncView onSynced={refreshData} />
        ) : view === 'browse' ? (
          <BrowseView
            conversations={conversations}
            onConvSelect={onConvSelect}
          />
        ) : view === 'claudeDesign' ? (
          <ClaudeDesignView onConvSelect={onConvSelect} />
        ) : view === 'claudeFiles' ? (
          <ClaudeFileBrowser onConvSelect={onConvSelect} />
        ) : view === 'profile' ? (
          <ProfileView onConvSelect={onConvSelect} />
        ) : (
          <div className={styles.content}>
            <SearchBar
              query={query}
              onQueryChange={onQueryChange}
              searchScope={searchScope}
              onSearchScopeChange={onSearchScopeChange}
              sort={sort}
              onSortChange={onSortChange}
              source={source}
              onSourceChange={onSourceChange}
              claudeKind={claudeKind}
              onClaudeKindChange={onClaudeKindChange}
              claudeProject={claudeProject}
              onClaudeProjectChange={onClaudeProjectChange}
              claudeProjects={claudeProjects}
              activeBranchOnly={activeBranchOnly}
              onBranchToggle={onBranchToggle}
              resultCount={searchScope === 'code' ? codeResults.length : searchScope === 'files' ? fileResults.length : results.length}
              codeLangs={codeLangs}
              selectedLang={selectedLang}
              onLangChange={onLangChange}
              activeConvId={activeConvId}
              onClearConv={() => { setActiveConvId(null); triggerSearch({ convId: null }) }}
              showFilesScope={searchFlags.restoreSearchResults}
            />
            {stats && <StatsBar stats={stats} onNavigate={onViewChange} />}
            {searchScope === 'code' ? (
              <ResultsList
                results={[]}
                fileResults={[]}
                codeResults={codeResults}
                query={query}
                onSelect={setSelectedMsg}
                onFileSelect={setSelectedMsg as any}
                onConvOpen={onConvSelect}
                selectedId={selectedMsg?.id}
                searchScope="code"
              />
            ) : searchScope === 'files' ? (
              <ResultsList
                results={[]}
                fileResults={fileResults}
                codeResults={[]}
                query={query}
                onSelect={setSelectedMsg}
                onFileSelect={setSelectedMsg as any}
                onConvOpen={onConvSelect}
                selectedId={selectedMsg?.id}
                searchScope="files"
              />
            ) : (
              <ResultsList
                results={results}
                fileResults={[]}
                codeResults={[]}
                query={query}
                onSelect={setSelectedMsg}
                onFileSelect={setSelectedMsg as any}
                onConvOpen={onConvSelect}
                selectedId={selectedMsg?.id}
                searchScope="messages"
              />
            )}
          </div>
        )}

        {view === 'search' && !viewingConvId && selectedMsg && (
          <DetailPanel
            message={selectedMsg}
            onClose={() => setSelectedMsg(null)}
            onConvOpen={onConvSelect}
          />
        )}
      </div>
    </div>
  )
}
