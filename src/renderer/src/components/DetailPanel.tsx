import { useState, useEffect } from 'react'
import type { Message } from '../App'
import styles from './DetailPanel.module.css'

interface Props {
  message: Message
  onClose: () => void
}

interface ThreadMsg {
  id: string
  role: string
  text: string
  create_time: number | null
  has_code: number
  has_image: number
  word_count: number
  is_active_branch: number
  conv_title: string
}

interface CodeBlock {
  id: number
  lang: string
  code: string
  position: number
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g
type Segment = { type: 'text'; content: string } | { type: 'code'; lang: string; code: string }

function parseSegments(text: string): Segment[] {
  const segs: Segment[] = []
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

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })
}

export function DetailPanel({ message, onClose }: Props) {
  const [thread, setThread] = useState<ThreadMsg[]>([])
  const [codeBlocks, setCodeBlocks] = useState<CodeBlock[]>([])
  const [tab, setTab] = useState<'context' | 'code'>('context')
  const [copiedId, setCopiedId] = useState<number | null>(null)

  useEffect(() => {
    setThread([])
    setCodeBlocks([])
    window.api.messageContext(message.id).then(setThread)
    if (message.has_code) {
      window.api.codeBlocks(message.id).then(setCodeBlocks)
    }
  }, [message.id])

  async function copy(text: string, id: number) {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1800)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'context' ? styles.activeTab : ''}`}
            onClick={() => setTab('context')}
          >
            Thread context
          </button>
          {message.has_code === 1 && (
            <button
              className={`${styles.tab} ${tab === 'code' ? styles.activeTab : ''}`}
              onClick={() => setTab('code')}
            >
              Code ({codeBlocks.length})
            </button>
          )}
        </div>
        <button className={styles.closeBtn} onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 2l8 8M10 2l-8 8"/>
          </svg>
        </button>
      </div>

      {tab === 'context' && (
        <div className={styles.content}>
          {/* Message metadata */}
          <div className={styles.metaCard}>
            <div className={styles.metaRow}>
              <span className={styles.metaKey}>Conversation</span>
              <span className={styles.metaVal}>{message.conv_title || 'Untitled'}</span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaKey}>Date</span>
              <span className={styles.metaVal}>{fmtDate(message.create_time)}</span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaKey}>Role</span>
              <span className={styles.metaVal}>{message.role}</span>
            </div>
            {message.model && (
              <div className={styles.metaRow}>
                <span className={styles.metaKey}>Model</span>
                <span className={`${styles.metaVal} ${styles.mono}`}>{message.model}</span>
              </div>
            )}
            <div className={styles.metaRow}>
              <span className={styles.metaKey}>Words</span>
              <span className={`${styles.metaVal} ${styles.mono}`}>{message.word_count}</span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaKey}>Branch</span>
              <span className={`${styles.metaVal} ${message.is_active_branch ? styles.activeBranch : styles.inactiveBranch}`}>
                {message.is_active_branch ? 'Active (current_node path)' : `Regenerated branch #${message.branch_index}`}
              </span>
            </div>
          </div>

          {/* Thread */}
          <div className={styles.threadLabel}>
            Conversation thread ({thread.length} messages)
          </div>

          <div className={styles.thread}>
            {thread.length === 0 ? (
              <div className={styles.loading}>Loading…</div>
            ) : (
              thread.map(m => (
                <div
                  key={m.id}
                  className={`${styles.threadMsg}
                    ${m.role === 'user' ? styles.userMsg : styles.aiMsg}
                    ${m.id === message.id ? styles.highlighted : ''}`}
                >
                  <div className={styles.threadRole}>
                    {m.role === 'user' ? 'You' : 'ChatGPT'}
                    {m.create_time && <span className={styles.threadTime}>{fmtDate(m.create_time)}</span>}
                    {m.is_active_branch === 0 && <span className={styles.branchBadge}>branch</span>}
                  </div>
                  <div className={styles.threadText}>
                    {parseSegments(m.text).map((seg, i) =>
                      seg.type === 'text' ? (
                        seg.content.trim() && (
                          <div key={i} className={styles.threadTextBlock}>{seg.content.trim()}</div>
                        )
                      ) : (
                        <div key={i} className={styles.inlineCodeBlock}>
                          <div className={styles.inlineCodeHeader}>{seg.lang}</div>
                          <pre className={styles.inlineCode}>{seg.code}</pre>
                        </div>
                      )
                    )}
                  </div>
                  {(m.has_code === 1 || m.has_image === 1) && (
                    <div className={styles.threadBadges}>
                      {m.has_code === 1 && <span className={styles.tBadgeCode}>code</span>}
                      {m.has_image === 1 && <span className={styles.tBadgeImg}>image</span>}
                      <span className={styles.tBadgeWords}>{m.word_count}w</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === 'code' && (
        <div className={styles.content}>
          {codeBlocks.length === 0 ? (
            <div className={styles.loading}>Loading…</div>
          ) : (
            codeBlocks.map((cb, i) => (
              <div key={cb.id} className={styles.codeBlock}>
                <div className={styles.codeBlockHeader}>
                  <span className={styles.codeLang}>{cb.lang || 'text'}</span>
                  <button
                    className={styles.copyBtn}
                    onClick={() => copy(cb.code, cb.id)}
                  >
                    {copiedId === cb.id ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <pre className={styles.code}>{cb.code}</pre>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
