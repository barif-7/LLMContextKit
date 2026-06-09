import { useEffect, useMemo, useState } from 'react'
import type { ClaudeDesignFile, ClaudeDesignProject, ClaudeFileTreeItem } from '../App'
import styles from './ClaudeViews.module.css'

interface Props {
  onConvSelect: (id: string) => void
}

function fmtDate(ts: number | null): string {
  if (!ts) return 'No date'
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return '/'
  return parts.slice(0, -1).join('/')
}

function previewText(row: ClaudeDesignFile | null): string {
  const value = (row?.content || row?.message_text || '').trim()
  if (!value) return 'No captured content for this file event.'
  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value
}

export function ClaudeFileBrowser({ onConvSelect }: Props) {
  const [projects, setProjects] = useState<ClaudeDesignProject[]>([])
  const [items, setItems] = useState<ClaudeFileTreeItem[]>([])
  const [history, setHistory] = useState<ClaudeDesignFile[]>([])
  const [selectedProject, setSelectedProject] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    window.api.claudeDesignProjects().then(setProjects)
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      window.api.claudeFileTree({ projectName: selectedProject, query, limit: 1500 }).then((rows) => {
        setItems(rows)
        setSelectedPath((current) => rows.some((row) => row.file_path === current) ? current : rows[0]?.file_path ?? null)
      })
    }, 120)
    return () => window.clearTimeout(timeout)
  }, [selectedProject, query])

  useEffect(() => {
    if (!selectedPath) {
      setHistory([])
      return
    }
    window.api.claudeDesignFiles({
      projectName: selectedProject,
      filePath: selectedPath,
      limit: 100,
    }).then(setHistory)
  }, [selectedProject, selectedPath])

  const selected = history[0] ?? null
  const grouped = useMemo(() => {
    const groups = new Map<string, ClaudeFileTreeItem[]>()
    for (const item of items) {
      const key = folderName(item.file_path)
      const rows = groups.get(key) ?? []
      rows.push(item)
      groups.set(key, rows)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [items])

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Claude File Browser</h1>
          <div className={styles.subtitle}>
            {items.length.toLocaleString()} indexed paths from Claude chats, attachments, and project docs
          </div>
        </div>
        <div className={styles.searchWrap}>
          <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="6" cy="6" r="4" /><path d="M9 9l3.5 3.5" />
          </svg>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter paths and file contents"
            spellCheck={false}
          />
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.projectRail}>
          <button
            className={`${styles.projectBtn} ${selectedProject === 'all' ? styles.projectActive : ''}`}
            onClick={() => setSelectedProject('all')}
          >
            <span>All projects</span>
            <strong>{projects.reduce((sum, project) => sum + project.file_count, 0).toLocaleString()}</strong>
          </button>
          {projects.map((project) => (
            <button
              key={`${project.project_uuid}:${project.project_name}`}
              className={`${styles.projectBtn} ${selectedProject === project.project_name ? styles.projectActive : ''}`}
              onClick={() => setSelectedProject(project.project_name)}
            >
              <span>{project.project_name}</span>
              <strong>{project.file_count.toLocaleString()}</strong>
            </button>
          ))}
        </aside>

        <main className={styles.browserList}>
          {grouped.length === 0 && <div className={styles.empty}>No files match this filter</div>}
          {grouped.map(([folder, rows]) => (
            <section className={styles.folderGroup} key={folder}>
              <div className={styles.folderHeader}>
                <span>{folder}</span>
                <strong>{rows.length}</strong>
              </div>
              {rows.map((item) => (
                <button
                  key={`${item.project_name}:${item.file_path}`}
                  className={`${styles.pathRow} ${selectedPath === item.file_path ? styles.rowActive : ''}`}
                  onClick={() => setSelectedPath(item.file_path)}
                >
                  <span className={styles.pathName}>{item.file_name || item.file_path}</span>
                  <span className={styles.pathMeta}>
                    {item.file_type || 'file'} · {item.event_count} events · {fmtDate(item.last_activity)}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </main>

        <aside className={styles.previewPane}>
          {selected ? (
            <>
              <div className={styles.previewHeader}>
                <div>
                  <h2>{selected.file_name || selected.file_path}</h2>
                  <p>{selected.file_path}</p>
                </div>
                <button className={styles.secondaryBtn} onClick={() => onConvSelect(selected.conv_id)}>
                  Open Conversation
                </button>
              </div>
              <div className={styles.historyList}>
                {history.map((event) => (
                  <button
                    key={event.id}
                    className={styles.historyRow}
                    onClick={() => onConvSelect(event.conv_id)}
                  >
                    <span>{event.operation.replaceAll('_', ' ')}</span>
                    <strong>{fmtDate(event.created_at)}</strong>
                  </button>
                ))}
              </div>
              <pre className={styles.previewText}>{previewText(selected)}</pre>
            </>
          ) : (
            <div className={styles.empty}>Select a Claude file</div>
          )}
        </aside>
      </div>
    </div>
  )
}
