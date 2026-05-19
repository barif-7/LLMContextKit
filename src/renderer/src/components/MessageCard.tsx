import React, { useCallback, useState } from 'react'
import type { Message } from '../App'
import styles from './MessageCard.module.css'

interface Props {
  message: Message
  query: string
  isSelected: boolean
  onSelect: (msg: Message) => void
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g

type Seg = { type: 'text'; content: string } | { type: 'code'; lang: string; code: string }

function highlight(text: string, query: string): React.ReactNode[] {
  if (!query.trim()) return [text]
  const q = query.trim().toLowerCase()
  const result: React.ReactNode[] = []
  let i = 0
  const lower = text.toLowerCase()
  while (i < text.length) {
    const idx = lower.indexOf(q, i)
    if (idx === -1) { result.push(text.slice(i)); break }
    if (idx > i) result.push(text.slice(i, idx))
    result.push(<mark key={idx} className={styles.mark}>{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  return result
}

function fmtDate(ts: number | null): string {
  if (!ts) return 'unknown date'
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function parseSegments(text: string): Seg[] {
  const segs: Seg[] = []
  let last = 0
  CODE_FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODE_FENCE_RE.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', content: text.slice(last, m.index) })
    segs.push({ type: 'code', lang: m[1]?.trim() || 'text', code: m[2]?.trim() || '' })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ type: 'text', content: text.slice(last) })
  return segs
}

export function MessageCard({ message: msg, query, isSelected, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const langs: string[] = msg.code_langs ? JSON.parse(msg.code_langs) : []
  const segments = parseSegments(msg.text)
  const roleIsUser = msg.role === 'user'
  const needsClamp = msg.text.length > 1400 || msg.word_count > 220 || msg.has_code === 1

  const copyCode = useCallback(async (code: string, idx: number) => {
    await navigator.clipboard.writeText(code)
    setCopiedId(idx)
    setTimeout(() => setCopiedId(null), 1400)
  }, [])

  return (
    <article className={`${styles.card} ${isSelected ? styles.selected : ''}`}>
      <header className={styles.header}>
        <div className={`${styles.avatar} ${roleIsUser ? styles.avatarUser : styles.avatarAI}`}>
          {roleIsUser ? 'You' : 'AI'}
        </div>

        <div className={styles.meta}>
          <div className={styles.metaTop}>
            <span className={styles.role}>{roleIsUser ? 'You' : msg.source === 'claude' ? 'Claude' : 'ChatGPT'}</span>
            <span
              className={styles.badge}
              style={msg.source === 'claude'
                ? { background: 'rgba(217,119,87,0.14)', color: '#d97757' }
                : { background: 'var(--green-dim)', color: 'var(--green)' }}
              title={msg.source === 'claude' ? 'Claude' : 'ChatGPT'}
            >
              {msg.source === 'claude' ? 'C' : 'G'}
            </span>
            {msg.model && <span className={styles.model}>{msg.model}</span>}
            <span className={styles.time}>{fmtDate(msg.create_time)}</span>
          </div>
          <div className={styles.convTitle} title={msg.conv_title}>
            {msg.conv_title || 'Untitled conversation'}
          </div>
        </div>

        <div className={styles.badges}>
          {msg.has_code === 1 && langs.slice(0, 2).map(l => (
            <span key={l} className={`${styles.badge} ${styles.badgeCode}`}>{l}</span>
          ))}
          {msg.has_image === 1 && <span className={`${styles.badge} ${styles.badgeImage}`}>image</span>}
          {msg.is_active_branch === 0 && <span className={`${styles.badge} ${styles.badgeBranch}`}>branch</span>}
        </div>

        <button className={styles.contextBtn} onClick={() => onSelect(msg)}>
          Context
        </button>
      </header>

      <div className={`${styles.body} ${expanded ? styles.bodyFull : styles.bodyPreview}`}>
        {msg.has_image === 1 && (
          <div className={styles.imageNote}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="2.5" width="11" height="9" rx="1.5"/>
              <circle cx="4.5" cy="5.5" r="1"/><path d="M1.5 10l3-3 2 2 3-3.5 3.5 4"/>
            </svg>
            Image attachment referenced in export
          </div>
        )}

        {segments.map((seg, i) =>
          seg.type === 'text' ? (
            seg.content.trim() && (
              <div key={i} className={styles.textBlock}>
                {highlight(seg.content.trim(), query)}
              </div>
            )
          ) : (
            <div key={i} className={styles.codeWrap}>
              <div className={styles.codeHeader}>
                <span className={styles.codeLang}>{seg.lang}</span>
                <button className={styles.copyBtn} onClick={() => copyCode(seg.code, i)}>
                  {copiedId === i ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className={styles.code}>{highlight(seg.code, query)}</pre>
            </div>
          )
        )}
      </div>

      <footer className={styles.bodyFooter}>
        <span className={styles.messageStats}>{msg.word_count.toLocaleString()} words</span>
        {needsClamp && (
          <button className={styles.expandBtn} onClick={() => setExpanded(e => !e)}>
            {expanded ? 'Collapse' : 'Show full message'}
          </button>
        )}
      </footer>
    </article>
  )
}
