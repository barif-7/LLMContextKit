import { useEffect, useMemo, useState } from 'react'
import type { ClaudeDesignFile, ClaudeDesignProject } from '../App'
import styles from './ClaudeViews.module.css'

interface Props {
  onConvSelect: (id: string) => void
}

const OPERATIONS = [
  'all',
  'write_file',
  'str_replace_edit',
  'read_file',
  'list_files',
  'attachment',
  'project_doc',
  'copy_files',
  'error',
]

function fmtDate(ts: number | null): string {
  if (!ts) return 'No date'
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function compact(text: string | null | undefined, fallback = 'No preview'): string {
  const value = (text || '').trim()
  return value.length > 900 ? `${value.slice(0, 900)}...` : value || fallback
}

export function ClaudeDesignView({ onConvSelect }: Props) {
  const [projects, setProjects] = useState<ClaudeDesignProject[]>([])
  const [files, setFiles] = useState<ClaudeDesignFile[]>([])
  const [selectedProject, setSelectedProject] = useState('all')
  const [operation, setOperation] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    window.api.claudeDesignProjects().then(setProjects)
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      window.api.claudeDesignFiles({
        projectName: selectedProject,
        operation,
        query,
        limit: 400,
      }).then((rows) => {
        setFiles(rows)
        setSelectedId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null)
      })
    }, 120)
    return () => window.clearTimeout(timeout)
  }, [selectedProject, operation, query])

  const selected = useMemo(
    () => files.find((file) => file.id === selectedId) ?? files[0] ?? null,
    [files, selectedId]
  )

  const totals = useMemo(() => {
    return projects.reduce((acc, project) => ({
      file_events: acc.file_events + project.file_events,
      file_count: acc.file_count + project.file_count,
      conversation_count: acc.conversation_count + project.conversation_count,
    }), { file_events: 0, file_count: 0, conversation_count: 0 })
  }, [projects])

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Claude Design Files</h1>
          <div className={styles.subtitle}>
            {totals.file_count.toLocaleString()} files, {totals.file_events.toLocaleString()} events, {totals.conversation_count.toLocaleString()} conversations
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
            placeholder="Search files, content, projects"
            spellCheck={false}
          />
        </div>
      </header>

      <div className={styles.toolbar}>
        {OPERATIONS.map((item) => (
          <button
            key={item}
            className={`${styles.filterBtn} ${operation === item ? styles.filterActive : ''}`}
            onClick={() => setOperation(item)}
          >
            {item === 'all' ? 'All' : item.replaceAll('_', ' ')}
          </button>
        ))}
      </div>

      <div className={styles.workspace}>
        <aside className={styles.projectRail}>
          <button
            className={`${styles.projectBtn} ${selectedProject === 'all' ? styles.projectActive : ''}`}
            onClick={() => setSelectedProject('all')}
          >
            <span>All Claude projects</span>
            <strong>{totals.file_events.toLocaleString()}</strong>
          </button>
          {projects.map((project) => (
            <button
              key={`${project.project_uuid}:${project.project_name}`}
              className={`${styles.projectBtn} ${selectedProject === project.project_name ? styles.projectActive : ''}`}
              onClick={() => setSelectedProject(project.project_name)}
            >
              <span>{project.project_name}</span>
              <strong>{project.file_events.toLocaleString()}</strong>
            </button>
          ))}
        </aside>

        <main className={styles.eventList}>
          {files.length === 0 && <div className={styles.empty}>No Claude design files found</div>}
          {files.map((file) => (
            <button
              key={file.id}
              className={`${styles.fileRow} ${selected?.id === file.id ? styles.rowActive : ''}`}
              onClick={() => setSelectedId(file.id)}
            >
              <span className={styles.fileName}>{file.file_name || file.file_path}</span>
              <span className={styles.filePath}>{file.file_path}</span>
              <span className={styles.rowMeta}>
                <span className={styles.op}>{file.operation.replaceAll('_', ' ')}</span>
                <span>{file.project_name || 'Unassigned'}</span>
                <span>{fmtDate(file.created_at)}</span>
              </span>
            </button>
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
              <div className={styles.factGrid}>
                <span><strong>Project</strong>{selected.project_name || 'Unassigned'}</span>
                <span><strong>Operation</strong>{selected.operation.replaceAll('_', ' ')}</span>
                <span><strong>Source</strong>{selected.source_kind}</span>
                <span><strong>Date</strong>{fmtDate(selected.created_at)}</span>
              </div>
              <pre className={styles.previewText}>{compact(selected.content || selected.message_text)}</pre>
            </>
          ) : (
            <div className={styles.empty}>Select a file event</div>
          )}
        </aside>
      </div>
    </div>
  )
}
