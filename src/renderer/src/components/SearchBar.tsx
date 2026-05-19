import type { SortOrder, SourceFilter } from '../App'
import styles from './SearchBar.module.css'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  sort: SortOrder
  onSortChange: (s: SortOrder) => void
  source: SourceFilter
  onSourceChange: (s: SourceFilter) => void
  activeBranchOnly: boolean
  onBranchToggle: () => void
  resultCount: number
}

export function SearchBar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  source,
  onSourceChange,
  activeBranchOnly,
  onBranchToggle,
  resultCount,
}: Props) {
  return (
    <div className={styles.bar}>
      <div className={styles.inputWrap}>
        <svg className={styles.searchIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>
        </svg>
        <input
          type="text"
          className={styles.input}
          placeholder="Search messages, code, topics…"
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

      <div className={styles.controls}>
        <button
          className={`${styles.toggle} ${activeBranchOnly ? styles.toggleOn : ''}`}
          onClick={onBranchToggle}
          title={activeBranchOnly ? 'Showing active branch only — click to show all branches' : 'Showing all branches'}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="3.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="9.5" r="1.5"/>
            <circle cx="9.5" cy="6.5" r="1.5"/>
            <path d="M3.5 5v3M3.5 5c0 0 6 0 6 1.5"/>
          </svg>
          {activeBranchOnly ? 'Active branch' : 'All branches'}
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

        <span className={styles.count}>
          {resultCount.toLocaleString()} result{resultCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  )
}
