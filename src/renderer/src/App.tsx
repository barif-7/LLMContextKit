import { useState, useEffect, useCallback, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { SearchBar } from './components/SearchBar'
import { ResultsList } from './components/ResultsList'
import { DetailPanel } from './components/DetailPanel'
import { ImportScreen } from './components/ImportScreen'
import { StatsBar } from './components/StatsBar'
import { McpPanel } from './components/McpPanel'
import styles from './App.module.css'

export type ViewFilter = 'all' | 'code' | 'images' | 'long' | 'user' | 'assistant' | 'branches'
export type SortOrder = 'newest' | 'oldest' | 'longest' | 'relevance'
export type SourceFilter = 'all' | 'chatgpt' | 'claude'
type AppMode = 'search' | 'mcp'

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

export interface Conversation {
  id: string
  title: string
  create_time: number
  update_time: number
  msg_count: number
}

export interface Stats {
  messages: number
  conversations: number
  withCode: number
  withImages: number
  totalWords: number
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
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all')
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [sort, setSort] = useState<SortOrder>('newest')
  const [activeBranchOnly, setActiveBranchOnly] = useState(true)
  const [source, setSource] = useState<SourceFilter>('all')
  const [mode, setMode] = useState<AppMode>('search')

  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null)

  const searchTimeout = useRef<ReturnType<typeof setTimeout>>()

  // ── Load data on mount ───────────────────────────────────────────────────
  useEffect(() => {
    checkForData()
  }, [])

  async function checkForData() {
    const s = await window.api.stats()
    if (s.messages > 0) {
      setStats(s)
      setHasData(true)
      loadConversations()
      doSearch({ q: '', view: 'all', convId: null, sort: 'newest', activeBranchOnly: true, source: 'all' })
    }
  }

  async function loadConversations() {
    const convs = await window.api.conversations()
    setConversations(convs)
  }

  // ── Import ────────────────────────────────────────────────────────────────
  async function handleImport(filePath?: string) {
    setImportError(null)
    let path = filePath
    if (!path) {
      path = await window.api.openFile()
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
        doSearch({ q: query, view: viewFilter, convId: activeConvId, sort, activeBranchOnly, source })
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

  // ── Search ────────────────────────────────────────────────────────────────
  const doSearch = useCallback(async (params: {
    q: string; view: ViewFilter; convId: string | null; sort: SortOrder; activeBranchOnly: boolean; source: SourceFilter
  }) => {
    const { q, view, convId, sort, activeBranchOnly, source } = params
    const searchParams: any = {
      query: q || undefined,
      convId: convId || undefined,
      sort,
      activeBranchOnly,
      source,
    }
    if (view === 'code') searchParams.hasCode = true
    else if (view === 'images') searchParams.hasImage = true
    else if (view === 'long') searchParams.isLong = true
    else if (view === 'user') searchParams.role = 'user'
    else if (view === 'assistant') searchParams.role = 'assistant'
    else if (view === 'branches') searchParams.activeBranchOnly = false

    const rows = await window.api.search(searchParams)
    setResults(rows)
  }, [])

  function triggerSearch(overrides?: Partial<{ q: string; view: ViewFilter; convId: string | null; sort: SortOrder; activeBranchOnly: boolean; source: SourceFilter }>) {
    clearTimeout(searchTimeout.current)
    const params = {
      q: query,
      view: viewFilter,
      convId: activeConvId,
      sort,
      activeBranchOnly,
      source,
      ...overrides,
    }
    searchTimeout.current = setTimeout(() => doSearch(params), overrides?.q !== undefined ? 120 : 0)
  }

  function onQueryChange(q: string) {
    setQuery(q)
    triggerSearch({ q })
  }

  function onViewChange(v: ViewFilter) {
    setMode('search')
    setViewFilter(v)
    setActiveConvId(null)
    triggerSearch({ view: v, convId: null })
  }

  function onConvSelect(id: string | null) {
    setMode('search')
    setActiveConvId(id)
    setSelectedMsg(null)
    if (id) {
      setQuery('')
      setViewFilter('all')
      doSearch({ q: '', view: 'all', convId: id, sort, activeBranchOnly, source })
    } else {
      triggerSearch({ convId: null })
    }
  }

  function onSortChange(s: SortOrder) {
    setSort(s)
    triggerSearch({ sort: s })
  }

  function onSourceChange(s: SourceFilter) {
    setSource(s)
    triggerSearch({ source: s })
  }

  function onBranchToggle() {
    const next = !activeBranchOnly
    setActiveBranchOnly(next)
    triggerSearch({ activeBranchOnly: next })
  }

  function onMcpSelect() {
    setMode('mcp')
    setActiveConvId(null)
    setSelectedMsg(null)
  }

  // ── Drag and drop on main window ─────────────────────────────────────────
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
      {/* Titlebar drag region */}
      <div className={`${styles.titlebar} drag-region`} />

      <div className={styles.layout}>
        <Sidebar
          conversations={conversations}
          activeConvId={activeConvId}
          activeView={viewFilter}
          stats={stats}
          onConvSelect={onConvSelect}
          onViewChange={onViewChange}
          onReimport={() => handleImport()}
          onMcpSelect={onMcpSelect}
          mcpActive={mode === 'mcp'}
        />

        {mode === 'mcp' ? (
          <McpPanel />
        ) : (
          <div className={styles.content}>
            <SearchBar
              query={query}
              onQueryChange={onQueryChange}
              sort={sort}
              onSortChange={onSortChange}
              source={source}
              onSourceChange={onSourceChange}
              activeBranchOnly={activeBranchOnly}
              onBranchToggle={onBranchToggle}
              resultCount={results.length}
            />
            {stats && <StatsBar stats={stats} />}
            <ResultsList
              results={results}
              query={query}
              onSelect={setSelectedMsg}
              selectedId={selectedMsg?.id}
            />
          </div>
        )}

        {mode === 'search' && selectedMsg && (
          <DetailPanel
            message={selectedMsg}
            onClose={() => setSelectedMsg(null)}
          />
        )}
      </div>
    </div>
  )
}
