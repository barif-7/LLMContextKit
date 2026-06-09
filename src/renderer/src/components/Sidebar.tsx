import type { AppView, Stats } from '../App'
import styles from './Sidebar.module.css'

interface Props {
  activeView: AppView
  stats: Stats | null
  onViewChange: (v: AppView) => void
  onReimport: () => void
  onMergeImport: () => void
}

const NAV_ITEMS: { id: AppView; label: string; icon: React.ReactNode }[] = [
  {
    id: 'search', label: 'Search',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5L13 13"/></svg>,
  },
  {
    id: 'browse', label: 'Browse',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2" width="11" height="11" rx="1.5"/><line x1="2" y1="5.5" x2="13" y2="5.5"/><line x1="5.5" y1="5.5" x2="5.5" y2="13"/></svg>,
  },
  {
    id: 'claudeDesign', label: 'Design Files',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 3h9v3H3zM3 8.5h4v3.5H3zM9 8.5h3v3.5H9z"/></svg>,
  },
  {
    id: 'claudeFiles', label: 'Claude Files',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 4.5h4l1 1h5v6.5h-10z"/><path d="M2.5 4.5V3h3.5l1 1.5"/></svg>,
  },
  {
    id: 'profile', label: 'Profile',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="7.5" cy="5" r="2.5"/><path d="M3 13c0-2.5 2-4.5 4.5-4.5S12 10.5 12 13"/></svg>,
  },
  {
    id: 'sync', label: 'Sync',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 6.5A4.5 4.5 0 0110.5 3.5M2 2v4h4"/><path d="M13 8.5A4.5 4.5 0 014.5 11.5M13 13V9H9"/></svg>,
  },
  {
    id: 'mcp', label: 'MCP Setup',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 3h5v3H5zM2.5 9.5h4v2h-4zM8.5 9.5h4v2h-4z"/><path d="M7.5 6v3.5M4.5 9.5V8h6v1.5"/></svg>,
  },
]

export function Sidebar({ activeView, stats, onViewChange, onReimport, onMergeImport }: Props) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <span className={styles.logoText}>History<em>Kit</em></span>
      </div>

      <nav className={styles.nav}>
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`${styles.navBtn} ${activeView === item.id ? styles.active : ''}`}
            onClick={() => onViewChange(item.id)}
          >
            <span className={styles.navIcon}>{item.icon}</span>
            <span className={styles.navLabel}>{item.label}</span>
          </button>
        ))}
      </nav>

      {stats && (
        <div className={styles.statsSection}>
          <div className={styles.sectionLabel}>Overview</div>
          <div className={styles.statGrid}>
            <div className={styles.statItem}>
              <span className={styles.statValue}>{stats.conversations.toLocaleString()}</span>
              <span className={styles.statLabel}>conversations</span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statValue}>{stats.messages.toLocaleString()}</span>
              <span className={styles.statLabel}>messages</span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statValue}>{stats.withCode.toLocaleString()}</span>
              <span className={styles.statLabel}>with code</span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statValue}>{(stats.totalWords / 1000).toFixed(0)}k</span>
              <span className={styles.statLabel}>words</span>
            </div>
          </div>
          {stats.bySource.chatgpt.messages > 0 && stats.bySource.claude.messages > 0 && (
            <div className={styles.sourceBreakdown}>
              <span className={styles.sourceBadge} style={{ color: 'var(--green, #4ade80)' }}>
                ChatGPT {stats.bySource.chatgpt.conversations}
              </span>
              <span className={styles.sourceBadge} style={{ color: '#d97757' }}>
                Claude {stats.bySource.claude.conversations}
              </span>
            </div>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <button className={styles.actionBtn} onClick={onReimport}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 6.5A4.5 4.5 0 0110.5 3.5M2 2v4h4"/><path d="M11 6.5A4.5 4.5 0 012.5 9.5M11 11V7H7"/></svg>
          Import
        </button>
        <button className={styles.actionBtn} onClick={onMergeImport}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M6.5 2v9M2.5 6.5h8"/></svg>
          Merge
        </button>
      </div>
    </aside>
  )
}
