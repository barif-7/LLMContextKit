import { useState, useEffect, useRef } from 'react'
import styles from './ConversationView.module.css'

interface Props {
  convId: string
  onBack: () => void
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
  source: string
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
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })
}

export function ConversationView({ convId, onBack }: Props) {
  const [messages, setMessages] = useState<ThreadMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedIdx, setCopiedIdx] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setMessages([])
    window.api.messagesByConversation(convId).then(msgs => {
      setMessages(msgs)
      setLoading(false)
    })
  }, [convId])

  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [loading])

  async function copyCode(code: string, id: string) {
    await navigator.clipboard.writeText(code)
    setCopiedIdx(id)
    setTimeout(() => setCopiedIdx(null), 1500)
  }

  const title = messages[0]?.conv_title || 'Conversation'
  const msgSource = messages[0]?.source
  const aiName = msgSource === 'claude' ? 'Claude' : 'ChatGPT'
  const userMsgCount = messages.filter(m => m.role === 'user').length
  const aiMsgCount = messages.filter(m => m.role !== 'user').length

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8.5 3L4 7l4.5 4"/>
          </svg>
          Back
        </button>
        <div className={styles.headerInfo}>
          <h1 className={styles.convTitle}>{title}</h1>
          {!loading && (
            <span className={styles.convMeta}>
              {messages.length} messages · {userMsgCount} from you · {aiMsgCount} from {aiName}
            </span>
          )}
        </div>
      </div>

      <div className={styles.thread} ref={scrollRef}>
        {loading ? (
          <div className={styles.loading}>Loading conversation…</div>
        ) : messages.length === 0 ? (
          <div className={styles.loading}>No messages found</div>
        ) : (
          messages.map((msg, i) => {
            const isUser = msg.role === 'user'
            const segments = parseSegments(msg.text)

            return (
              <div
                key={msg.id}
                className={`${styles.message} ${isUser ? styles.userMsg : styles.aiMsg}`}
              >
                <div className={styles.msgHeader}>
                  <span className={styles.msgRole}>
                    {isUser ? 'You' : msg.source === 'claude' ? 'Claude' : 'ChatGPT'}
                  </span>
                  {msg.create_time && (
                    <span className={styles.msgTime}>{fmtDate(msg.create_time)}</span>
                  )}
                  {msg.is_active_branch === 0 && (
                    <span className={styles.branchBadge}>branch</span>
                  )}
                  <span className={styles.msgWords}>{msg.word_count}w</span>
                </div>

                <div className={styles.msgBody}>
                  {msg.has_image === 1 && (
                    <div className={styles.imageNote}>
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <rect x="1" y="2" width="11" height="9" rx="1.5"/>
                        <circle cx="4" cy="5" r="1"/><path d="M1 9.5l3-3 2 2 3-3.5 3 3.5"/>
                      </svg>
                      Image referenced
                    </div>
                  )}

                  {segments.map((seg, si) =>
                    seg.type === 'text' ? (
                      seg.content.trim() && (
                        <div key={si} className={styles.textBlock}>
                          {seg.content.trim()}
                        </div>
                      )
                    ) : (
                      <div key={si} className={styles.codeWrap}>
                        <div className={styles.codeHeader}>
                          <span className={styles.codeLang}>{seg.lang}</span>
                          <button
                            className={styles.copyBtn}
                            onClick={() => copyCode(seg.code, `${msg.id}-${si}`)}
                          >
                            {copiedIdx === `${msg.id}-${si}` ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre className={styles.codeBlock}>{seg.code}</pre>
                      </div>
                    )
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
