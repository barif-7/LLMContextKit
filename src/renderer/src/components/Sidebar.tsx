import type { ViewFilter, Conversation, Stats } from '../App'
import styles from './Sidebar.module.css'

interface Props {
  conversations: Conversation[]
  activeConvId: string | null
  activeView: ViewFilter
  stats: Stats | null
  onConvSelect: (id: string | null) => void
  onViewChange: (v: ViewFilter) => void
  onReimport: () => void
  onMcpSelect: () => void
  mcpActive: boolean
}

const VIEWS: { id: ViewFilter; label: string; icon: React.ReactNode }[] = [
  {
    id: 'all', label: 'All messages',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><rect x="8.5" y="1.5" width="5" height="5" rx="1"/><rect x="1.5" y="8.5" width="5" height="5" rx="1"/><rect x="8.5" y="8.5" width="5" height="5" rx="1"/></svg>
  },
  {
    id: 'code', label: 'Code blocks',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><polyline points="4,4.5 1.5,7.5 4,10.5"/><polyline points="11,4.5 13.5,7.5 11,10.5"/><line x1="9" y1="2.5" x2="6" y2="12.5"/></svg>
  },
  {
    id: 'images', label: 'Images',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="3" width="12" height="9" rx="1.5"/><circle cx="5.5" cy="6" r="1"/><path d="M1.5 10.5l3-3 2 2 3-3 4 4"/></svg>
  },
  {
    id: 'long', label: 'Long replies',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><line x1="2.5" y1="4" x2="12.5" y2="4"/><line x1="2.5" y1="6.5" x2="12.5" y2="6.5"/><line x1="2.5" y1="9" x2="9" y2="9"/><line x1="2.5" y1="11.5" x2="7" y2="11.5"/></svg>
  },
  {
    id: 'branches', label: 'All branches',
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4" cy="4" r="1.5"/><circle cx="4" cy="11" r="1.5"/><circle cx="11" cy="8" r="1.5"/><path d="M4 5.5v4M4 5.5c0 0 7 0 7 2.5"/></svg>
  },
]

export function Sidebar({
  conversations,
  activeConvId,
  activeView,
  stats,
  onConvSelect,
  onViewChange,
  onReimport,
  onMcpSelect,
  mcpActive,
}: Props) {
  const statBadge = (view: ViewFilter): number | null => {
    if (!stats) return null
    if (view === 'all') return stats.messages
    if (view === 'code') return stats.withCode
    if (view === 'images') return stats.withImages
    return null
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <span className={styles.logoText}>History<em>Kit</em></span>
      </div>

      <nav className={styles.nav}>
        <div className={styles.sectionLabel}>Browse</div>
        {VIEWS.map(v => (
          <button
            key={v.id}
            className={`${styles.navBtn} ${activeView === v.id && !activeConvId ? styles.active : ''}`}
            onClick={() => { onConvSelect(null); onViewChange(v.id) }}
          >
            <span className={styles.navIcon}>{v.icon}</span>
            <span className={styles.navLabel}>{v.label}</span>
            {statBadge(v.id) !== null && (
              <span className={styles.badge}>{statBadge(v.id)!.toLocaleString()}</span>
            )}
          </button>
        ))}
      </nav>

      <div className={styles.convSection}>
        <div className={styles.sectionLabel}>
          Conversations
          <span className={styles.convCount}>{conversations.length}</span>
        </div>
        <div className={styles.convList}>
          {conversations.map(conv => (
            <button
              key={conv.id}
              className={`${styles.convItem} ${activeConvId === conv.id ? styles.activeConv : ''}`}
              onClick={() => onConvSelect(conv.id)}
              title={conv.title}
            >
              <span className={styles.convTitle}>{conv.title || 'Untitled'}</span>
              <span className={styles.convMsgs}>{conv.msg_count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <button
          className={`${styles.mcpBtn} ${mcpActive ? styles.mcpActive : ''}`}
          onClick={onMcpSelect}
          title="MCP setup"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M4.5 2.5h4v3h-4zM2 8.5h3.5v2H2zM7.5 8.5H11v2H7.5z"/>
            <path d="M6.5 5.5v3M3.75 8.5V7h5.5v1.5"/>
          </svg>
          MCP
        </button>
        <button className={styles.reimportBtn} onClick={onReimport}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 6.5A4.5 4.5 0 0110.5 3.5M2 2v4h4"/><path d="M11 6.5A4.5 4.5 0 012.5 9.5M11 11V7H7"/></svg>
          Re-import
        </button>
        {stats && (
          <span className={styles.footerStat}>{(stats.totalWords / 1000).toFixed(0)}k words indexed</span>
        )}
      </div>
    </aside>
  )
}
