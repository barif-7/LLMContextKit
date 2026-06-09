import type { SortOrder, SourceFilter, SearchScope } from '../App'
import styles from './SearchBar.module.css'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  searchScope: SearchScope
  onSearchScopeChange: (s: SearchScope) => void
  sort: SortOrder
  onSortChange: (s: SortOrder) => void
  source: SourceFilter
  onSourceChange: (s: SourceFilter) => void
  activeBranchOnly: boolean
  onBranchToggle: () => void
  resultCount: number
  codeLangs: Array<{ lang: string; count: number }>
  selectedLang: string | null
  onLangChange: (lang: string | null) => void
  activeConvId: string | null
  onClearConv: () => void
  showFilesScope: boolean
}

function scopes(showFilesScope: boolean): { id: SearchScope; label: string }[] {
  const items: { id: SearchScope; label: string }[] = [
    { id: 'messages', label: 'Messages' },
    { id: 'code', label: 'Code' },
  ]
  if (showFilesScope) items.push({ id: 'files', label: 'Files' })
  return items
}

export function SearchBar({
  query,
  onQueryChange,
  searchScope,
  onSearchScopeChange,
  sort,
  onSortChange,
  source,
  onSourceChange,
  activeBranchOnly,
  onBranchToggle,
  resultCount,
  codeLangs,
  selectedLang,
  onLangChange,
  activeConvId,
  onClearConv,
  showFilesScope,
}: Props) {
  const scopeItems = scopes(showFilesScope)
  return (
    <div className={styles.bar}>
      <div className={styles.inputRow}>
        <div className={styles.inputWrap}>
          <svg className={styles.searchIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>
          </svg>
          <input
            type="text"
            className={styles.input}
            placeholder={
              searchScope === 'code'
                ? 'Search code blocks…'
                : searchScope === 'files'
                  ? 'Search files and attachments…'
                  : 'Search messages, code, topics…'
            }
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button className={styles.clearBtn} onClick={() => onQueryChange('')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l8 8M10 2l-8 8"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.scopeTabs}>
          {scopeItems.map(s => (
            <button
              key={s.id}
              className={`${styles.scopeTab} ${searchScope === s.id ? styles.scopeActive : ''}`}
              onClick={() => onSearchScopeChange(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {activeConvId && (
          <button className={styles.convFilter} onClick={onClearConv}>
            In conversation
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 2l6 6M8 2l-6 6"/>
            </svg>
          </button>
        )}

        <div className={styles.spacer} />

        {searchScope === 'code' && codeLangs.length > 0 && (
          <select
            className={styles.sortSelect}
            value={selectedLang ?? ''}
            onChange={e => onLangChange(e.target.value || null)}
          >
            <option value="">All languages</option>
            {codeLangs.map(l => (
              <option key={l.lang} value={l.lang}>{l.lang} ({l.count})</option>
            ))}
          </select>
        )}

        {searchScope === 'messages' && (
          <>
            <button
              className={`${styles.toggle} ${activeBranchOnly ? styles.toggleOn : ''}`}
              onClick={onBranchToggle}
              title={activeBranchOnly ? 'Showing active branch only' : 'Showing all branches'}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="3.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="9.5" r="1.5"/>
                <circle cx="9.5" cy="6.5" r="1.5"/>
                <path d="M3.5 5v3M3.5 5c0 0 6 0 6 1.5"/>
              </svg>
            </button>

            <select
              className={styles.sortSelect}
              value={source}
              onChange={e => onSourceChange(e.target.value as SourceFilter)}
            >
              <option value="all">All sources</option>
              <option value="chatgpt">ChatGPT</option>
              <option value="claude">Claude</option>
            </select>

            <select
              className={styles.sortSelect}
              value={sort}
              onChange={e => onSortChange(e.target.value as SortOrder)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="longest">Longest first</option>
              {query && <option value="relevance">Relevance</option>}
            </select>
          </>
        )}

        <span className={styles.count}>
          {resultCount.toLocaleString()} result{resultCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  )
}
