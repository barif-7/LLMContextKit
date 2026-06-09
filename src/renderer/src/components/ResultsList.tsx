import type { FileSearchResult, Message, SearchScope } from '../App'
import { MessageCard } from './MessageCard'
import styles from './ResultsList.module.css'

interface Props {
  results: Message[]
  fileResults: FileSearchResult[]
  codeResults: any[]
  query: string
  onSelect: (msg: Message) => void
  onFileSelect: (msg: FileSearchResult) => void
  onConvOpen: (convId: string) => void
  selectedId?: string
  searchScope: SearchScope
}

function fmtDate(ts: number | null): string {
  if (!ts) return 'unknown date'
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function CodeResultCard({ result, query, onConvOpen }: { result: any; query: string; onConvOpen: (id: string) => void }) {
  return (
    <article className={styles.codeCard}>
      <div className={styles.codeCardHeader}>
        <span className={styles.codeLang}>{result.lang || 'text'}</span>
        <button className={styles.codeConv} onClick={() => onConvOpen(result.conv_id)}>
          {result.conv_title || 'Untitled'}
        </button>
        <span className={styles.codeDate}>{fmtDate(result.create_time)}</span>
      </div>
      <pre className={styles.codeBlock}>{result.code}</pre>
      {result.message_text && (
        <div className={styles.codeContext}>
          {result.message_text.slice(0, 200)}{result.message_text.length > 200 ? '...' : ''}
        </div>
      )}
    </article>
  )
}

function FileResultCard({ result, onSelect, onConvOpen }: { result: FileSearchResult; onSelect: (msg: FileSearchResult) => void; onConvOpen: (id: string) => void }) {
  const snippet = result.file_text || result.text || ''
  return (
    <article className={styles.fileCard}>
      <div className={styles.fileCardHeader}>
        <div className={styles.fileCardMeta}>
          <span className={styles.fileName}>{result.file_name || 'Unnamed file'}</span>
          <span className={styles.fileBadge}>{result.file_type || 'file'}</span>
          <span className={styles.fileDate}>{fmtDate(result.create_time)}</span>
        </div>
        <div className={styles.fileCardActions}>
          <button className={styles.fileActionBtn} onClick={() => onSelect(result)}>Context</button>
          <button className={styles.fileActionBtn} onClick={() => onConvOpen(result.conv_id)}>Conversation</button>
        </div>
      </div>
      <button className={styles.fileConvLink} onClick={() => onConvOpen(result.conv_id)}>
        {result.conv_title || 'Untitled conversation'}
      </button>
      <div className={styles.fileSnippet}>
        {snippet.slice(0, 420)}{snippet.length > 420 ? '...' : ''}
      </div>
    </article>
  )
}

export function ResultsList({ results, fileResults, codeResults, query, onSelect, onFileSelect, onConvOpen, selectedId, searchScope }: Props) {
  if (searchScope === 'code') {
    if (codeResults.length === 0) {
      return (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.3">
              <polyline points="8,8 3,14 8,20"/><polyline points="20,8 25,14 20,20"/><line x1="16" y1="5" x2="12" y2="23"/>
            </svg>
          </div>
          <p>No code blocks match your search</p>
          <span>Try different keywords or remove the language filter</span>
        </div>
      )
    }

    return (
      <div className={styles.list}>
        {codeResults.slice(0, 200).map((result, i) => (
          <CodeResultCard key={result.id ?? i} result={result} query={query} onConvOpen={onConvOpen} />
        ))}
        {codeResults.length > 200 && (
          <div className={styles.truncated}>
            Showing 200 of {codeResults.length.toLocaleString()} results
          </div>
        )}
      </div>
    )
  }

  if (searchScope === 'files') {
    if (fileResults.length === 0) {
      return (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="5" y="6" width="18" height="16" rx="2" />
              <path d="M9 10h10M9 14h8M9 18h6" />
            </svg>
          </div>
          <p>No files match your search</p>
          <span>Try different keywords or search within a narrower file name</span>
        </div>
      )
    }

    return (
      <div className={styles.list}>
        {fileResults.slice(0, 200).map((result) => (
          <FileResultCard key={result.file_id} result={result} onSelect={onFileSelect} onConvOpen={onConvOpen} />
        ))}
        {fileResults.length > 200 && (
          <div className={styles.truncated}>
            Showing 200 of {fileResults.length.toLocaleString()} results
          </div>
        )}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="13" cy="13" r="8"/><path d="M19 19l5 5"/>
            <path d="M10 13h6M13 10v6"/>
          </svg>
        </div>
        <p>No messages match your search</p>
        <span>Try different keywords or adjust the filters</span>
      </div>
    )
  }

  return (
    <div className={styles.list}>
      {results.slice(0, 300).map(msg => (
        <MessageCard
          key={msg.id}
          message={msg}
          query={query}
          isSelected={msg.id === selectedId}
          onSelect={onSelect}
          onConvOpen={onConvOpen}
        />
      ))}
      {results.length > 300 && (
        <div className={styles.truncated}>
          Showing 300 of {results.length.toLocaleString()} results — refine your search to narrow down
        </div>
      )}
    </div>
  )
}
