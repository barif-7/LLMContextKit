import { useEffect, useMemo, useState } from 'react'
import type { SearchFlags } from '../App'
import styles from './McpPanel.module.css'

export interface McpStatus {
  serverPath: string
  serverBuilt: boolean
  dbPath: string
  dbExists: boolean
  nodeVersion: string | null
  claudeConfigPath: string
  config: {
    command: string
    args: string[]
    env: Record<string, string>
  }
  tools: string[]
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`${styles.pill} ${ok ? styles.ok : styles.warn}`}>
      <span className={styles.dot} />
      {label}
    </span>
  )
}

export function McpPanel() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [searchFlags, setSearchFlags] = useState<SearchFlags>({
    restoreSearchResults: true,
    semanticSearchSuite: false,
  })

  async function refresh() {
    setStatus(await window.api.mcpStatus())
  }

  useEffect(() => {
    refresh()
    window.api.searchFlags().then(setSearchFlags).catch(() => {})
  }, [])

  const configText = useMemo(() => {
    if (!status) return ''
    return JSON.stringify({ mcpServers: { historykit: status.config } }, null, 2)
  }, [status])

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(configText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch (err: any) {
      setMessage(err?.message || 'Could not copy configuration.')
    }
  }

  async function installClaude() {
    setMessage(null)
    const result = await window.api.installClaudeMcp()
    if (result.ok) {
      setMessage(`Installed to ${result.configPath}`)
      refresh()
    } else {
      setMessage(result.error || 'Install failed.')
    }
  }

  async function updateSearchFlags(patch: Partial<SearchFlags>) {
    const next = await window.api.setSearchFlags(patch)
    setSearchFlags(next)
  }

  if (!status) {
    return (
      <div className={styles.panel}>
        <div className={styles.loading}>Loading MCP setup…</div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h1>MCP Setup</h1>
          <p>Connect Codex, Claude, Cursor, and other MCP clients to your local HistoryKit index.</p>
        </div>
        <button className={styles.secondaryBtn} onClick={refresh}>Refresh</button>
      </div>

      <div className={styles.statusRow}>
        <StatusPill ok={status.serverBuilt} label={status.serverBuilt ? 'Server built' : 'Server missing'} />
        <StatusPill ok={status.dbExists} label={status.dbExists ? 'Database found' : 'Database missing'} />
        <StatusPill ok={!!status.nodeVersion} label={status.nodeVersion || 'Node unavailable'} />
      </div>

      <section className={styles.section}>
        <h2>Search Modes</h2>
        <label className={styles.flagRow}>
          <input
            type="checkbox"
            checked={searchFlags.restoreSearchResults}
            onChange={e => void updateSearchFlags({ restoreSearchResults: e.target.checked })}
          />
          <span>
            <strong>Restore classic search</strong>
            <em>Keyword search over messages, code blocks, and file-backed results.</em>
          </span>
        </label>
        <label className={styles.flagRow}>
          <input
            type="checkbox"
            checked={searchFlags.semanticSearchSuite}
            onChange={e => void updateSearchFlags({ semanticSearchSuite: e.target.checked })}
          />
          <span>
            <strong>Semantic search suite</strong>
            <em>Reserved for embeddings-backed search later.</em>
          </span>
        </label>
      </section>

      <section className={styles.section}>
        <h2>Client Configuration</h2>
        <p>
          MCP clients launch HistoryKit as a stdio subprocess. Add this server entry to the client you want to use.
        </p>
        <pre className={styles.code}>{configText}</pre>
        <div className={styles.actions}>
          <button className={styles.primaryBtn} onClick={installClaude}>Install for Claude</button>
          <button className={styles.secondaryBtn} onClick={copyConfig}>{copied ? 'Copied' : 'Copy JSON'}</button>
          <button className={styles.secondaryBtn} onClick={() => window.api.showMcpConfig()}>Show Claude Config</button>
        </div>
        {message && <div className={styles.message}>{message}</div>}
      </section>

      <section className={styles.grid}>
        <div className={styles.infoBlock}>
          <h2>Paths</h2>
          <dl>
            <dt>MCP server</dt>
            <dd>{status.serverPath}</dd>
            <dt>SQLite database</dt>
            <dd>{status.dbPath}</dd>
            <dt>Claude config</dt>
            <dd>{status.claudeConfigPath}</dd>
          </dl>
        </div>

        <div className={styles.infoBlock}>
          <h2>Tools Exposed</h2>
          <div className={styles.tools}>
            {status.tools.map(tool => (
              <span key={tool}>{tool}</span>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
