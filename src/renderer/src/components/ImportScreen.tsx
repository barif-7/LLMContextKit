import { useRef, useState } from 'react'
import styles from './ImportScreen.module.css'

interface Props {
  onImport: () => void
  onFileSelect: (file: File) => void
  onDrop: (e: React.DragEvent) => void
  error?: string | null
}

export function ImportScreen({ onImport, onFileSelect, onDrop, error }: Props) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function onBrowseClick() {
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.click()
    } else {
      onImport()
    }
  }

  return (
    <div
      className={styles.root}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { setDragging(false); onDrop(e) }}
    >
      <div className={`${styles.titlebar} drag-region`} />

      <div className={styles.center}>
        <div className={styles.wordmark}>
          History<span>Kit</span>
        </div>
        <p className={styles.tagline}>Your ChatGPT and Claude conversations, finally searchable</p>

        <div
          className={`${styles.dropZone} ${dragging ? styles.dragOver : ''}`}
          onClick={onBrowseClick}
        >
          <input
            ref={inputRef}
            className={styles.fileInput}
            type="file"
            accept=".json,application/json"
            onChange={e => {
              const file = e.currentTarget.files?.[0]
              if (file) onFileSelect(file)
            }}
          />
          <div className={styles.dropIcon}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="6" y="4" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M20 4l6 6v14a2 2 0 01-2 2H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M20 4v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M11 16h10M16 11v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <h2>Drop your conversations.json</h2>
          <p>ChatGPT or Claude export — we'll detect the format automatically.</p>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.hint}>
            <span>ChatGPT → Settings → Data Controls → Export data</span>
            <br />
            <span>Claude: Settings → Privacy → Export Data</span>
          </div>
        </div>

        <div className={styles.features}>
          {[
            ['⚡', 'Instant search', 'SQLite FTS5 with BM25 ranking'],
            ['🌿', 'All branches', 'Indexes every regenerated response'],
            ['🔒', 'Fully local', 'Nothing leaves your machine'],
            ['💻', 'Code-aware', 'Browse and filter by code blocks'],
          ].map(([icon, title, desc]) => (
            <div className={styles.feature} key={title}>
              <span className={styles.featureIcon}>{icon}</span>
              <div>
                <div className={styles.featureTitle}>{title}</div>
                <div className={styles.featureDesc}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
