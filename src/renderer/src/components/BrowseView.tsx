import { useState, useMemo } from 'react'
import type { Conversation } from '../App'
import { ConversationView } from './ConversationView'
import styles from './BrowseView.module.css'

interface Props {
  conversations: Conversation[]
  onConvSelect: (id: string) => void
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function monthKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-')
  const d = new Date(Number(year), Number(month) - 1)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function BrowseView({ conversations, onConvSelect }: Props) {
  const [titleFilter, setTitleFilter] = useState('')
  const [openConvId, setOpenConvId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let list = conversations
    if (titleFilter.trim()) {
      const q = titleFilter.toLowerCase()
      list = list.filter(c => (c.title || '').toLowerCase().includes(q))
    }
    return list
  }, [conversations, titleFilter])

  const grouped = useMemo(() => {
    const groups: Record<string, Conversation[]> = {}
    for (const conv of filtered) {
      const key = conv.update_time ? monthKey(conv.update_time) : 'unknown'
      if (!groups[key]) groups[key] = []
      groups[key].push(conv)
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
  }, [filtered])

  if (openConvId) {
    return (
      <ConversationView
        convId={openConvId}
        onBack={() => setOpenConvId(null)}
      />
    )
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>Browse Conversations</h1>
        <span className={styles.count}>{filtered.length.toLocaleString()} conversations</span>
      </div>

      <div className={styles.filters}>
        <div className={styles.searchWrap}>
          <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="6" cy="6" r="4"/><path d="M9 9l3.5 3.5"/>
          </svg>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Filter by title…"
            value={titleFilter}
            onChange={e => setTitleFilter(e.target.value)}
            spellCheck={false}
          />
          {titleFilter && (
            <button className={styles.clearBtn} onClick={() => setTitleFilter('')}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l6 6M8 2l-6 6"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className={styles.timeline}>
        {grouped.length === 0 && (
          <div className={styles.empty}>No conversations found</div>
        )}
        {grouped.map(([key, convs]) => (
          <div key={key} className={styles.group}>
            <div className={styles.monthHeader}>
              <span className={styles.monthLabel}>{key === 'unknown' ? 'Unknown date' : monthLabel(key)}</span>
              <span className={styles.monthCount}>{convs.length}</span>
            </div>
            <div className={styles.convList}>
              {convs.map(conv => (
                <button
                  key={conv.id}
                  className={styles.convCard}
                  onClick={() => setOpenConvId(conv.id)}
                >
                  <div className={styles.convTitle}>{conv.title || 'Untitled conversation'}</div>
                  <div className={styles.convMeta}>
                    <span className={styles.convDate}>{conv.update_time ? fmtDate(conv.update_time) : '—'}</span>
                    <span className={styles.convMsgs}>{conv.msg_count} messages</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
