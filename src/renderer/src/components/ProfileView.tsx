import { useState, useEffect, useMemo } from 'react'
import { ConversationView } from './ConversationView'
import styles from './ProfileView.module.css'

interface Props {
  onConvSelect: (id: string) => void
}

type ProfileTab = 'memories' | 'links' | 'attachments'

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProfileView({ onConvSelect }: Props) {
  const [tab, setTab] = useState<ProfileTab>('memories')
  const [memories, setMemories] = useState<any[]>([])
  const [links, setLinks] = useState<any[]>([])
  const [imageAttachments, setImageAttachments] = useState<any[]>([])
  const [fileAttachments, setFileAttachments] = useState<any[]>([])
  const [attachmentType, setAttachmentType] = useState<'image' | 'file'>('file')
  const [loaded, setLoaded] = useState<Record<ProfileTab, boolean>>({ memories: false, links: false, attachments: false })
  const [openConvId, setOpenConvId] = useState<string | null>(null)

  useEffect(() => {
    if (tab === 'memories' && !loaded.memories) {
      window.api.listMemories().then(rows => {
        setMemories(rows)
        setLoaded(prev => ({ ...prev, memories: true }))
      })
    } else if (tab === 'links' && !loaded.links) {
      window.api.listLinks().then(rows => {
        setLinks(rows)
        setLoaded(prev => ({ ...prev, links: true }))
      })
    } else if (tab === 'attachments' && !loaded.attachments) {
      Promise.all([
        window.api.listAttachments('image'),
        window.api.listAttachments('file'),
      ]).then(([images, files]) => {
        setImageAttachments(images)
        setFileAttachments(files)
        setLoaded(prev => ({ ...prev, attachments: true }))
      })
    }
  }, [tab, loaded])

  const linksByDomain = useMemo(() => {
    const domains: Record<string, { count: number; urls: any[] }> = {}
    for (const link of links) {
      const domain = link.domain || 'unknown'
      if (!domains[domain]) domains[domain] = { count: 0, urls: [] }
      domains[domain].count++
      if (domains[domain].urls.length < 5) domains[domain].urls.push(link)
    }
    return Object.entries(domains)
      .sort(([, a], [, b]) => b.count - a.count)
  }, [links])

  const TABS: { id: ProfileTab; label: string; count: number }[] = [
    { id: 'memories', label: 'ChatGPT Memories', count: memories.length },
    { id: 'links', label: 'Links', count: links.length },
    { id: 'attachments', label: 'Attachments', count: imageAttachments.length + fileAttachments.length },
  ]

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
        <h1 className={styles.title}>Profile</h1>
        <p className={styles.subtitle}>Your AI conversation profile</p>
      </div>

      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {(loaded[t.id] && t.count > 0) && (
              <span className={styles.tabCount}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {tab === 'memories' && (
          <MemoriesSection
            memories={memories}
            loaded={loaded.memories}
            onOpenConv={setOpenConvId}
          />
        )}

        {tab === 'links' && (
          <LinksSection
            linksByDomain={linksByDomain}
            loaded={loaded.links}
            onOpenConv={setOpenConvId}
          />
        )}

        {tab === 'attachments' && (
          <AttachmentsSection
            images={imageAttachments}
            files={fileAttachments}
            type={attachmentType}
            onTypeChange={setAttachmentType}
            loaded={loaded.attachments}
            onOpenConv={setOpenConvId}
          />
        )}
      </div>
    </div>
  )
}

function MemoriesSection({ memories, loaded, onOpenConv }: {
  memories: any[]; loaded: boolean; onOpenConv: (id: string) => void
}) {
  if (!loaded) return <div className={styles.loading}>Loading memories…</div>
  if (memories.length === 0) return <div className={styles.empty}>No memories found. Import a ChatGPT export to see memory entries.</div>

  return (
    <div className={styles.section}>
      {memories.map((mem, i) => (
        <div key={mem.id ?? i} className={styles.memoryCard}>
          <div className={styles.memoryText}>{mem.text}</div>
          <div className={styles.memoryMeta}>
            <span>{fmtDate(mem.create_time)}</span>
            <button
              className={styles.convLink}
              onClick={() => onOpenConv(mem.conv_id)}
            >
              {mem.conv_title || 'Untitled'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function LinksSection({ linksByDomain, loaded, onOpenConv }: {
  linksByDomain: [string, { count: number; urls: any[] }][]
  loaded: boolean
  onOpenConv: (id: string) => void
}) {
  if (!loaded) return <div className={styles.loading}>Loading links…</div>
  if (linksByDomain.length === 0) return <div className={styles.empty}>No links found.</div>

  return (
    <div className={styles.section}>
      {linksByDomain.map(([domain, data]) => (
        <div key={domain} className={styles.domainGroup}>
          <div className={styles.domainHeader}>
            <span className={styles.domainName}>{domain}</span>
            <span className={styles.domainCount}>{data.count} link{data.count !== 1 ? 's' : ''}</span>
          </div>
          <div className={styles.urlList}>
            {data.urls.map((link, i) => (
              <div key={i} className={styles.urlRow}>
                <button
                  className={styles.urlText}
                  onClick={() => window.api.openExternal(link.url)}
                  title={link.url}
                >
                  {link.url}
                </button>
                <button
                  className={styles.convLink}
                  onClick={() => onOpenConv(link.conv_id)}
                >
                  {link.conv_title || 'Untitled'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function AttachmentsSection({ images, files, type, onTypeChange, loaded, onOpenConv }: {
  images: any[]; files: any[]; type: 'image' | 'file'
  onTypeChange: (t: 'image' | 'file') => void; loaded: boolean
  onOpenConv: (id: string) => void
}) {
  if (!loaded) return <div className={styles.loading}>Loading attachments…</div>

  const items = type === 'image' ? images : files

  return (
    <div className={styles.section}>
      <div className={styles.attachToggle}>
        <button
          className={`${styles.attachBtn} ${type === 'file' ? styles.attachActive : ''}`}
          onClick={() => onTypeChange('file')}
        >
          Files ({files.length})
        </button>
        <button
          className={`${styles.attachBtn} ${type === 'image' ? styles.attachActive : ''}`}
          onClick={() => onTypeChange('image')}
        >
          Images ({images.length})
        </button>
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>No {type}s found.</div>
      ) : (
        items.map((att, i) => (
          <div key={att.id ?? i} className={styles.attachCard}>
            <div className={styles.attachName}>
              {att.name || `Unnamed ${att.type}`}
            </div>
            <div className={styles.attachMeta}>
              {att.mime_type && <span className={styles.attachType}>{att.mime_type}</span>}
              {att.size_bytes > 0 && <span>{fmtSize(att.size_bytes)}</span>}
              {att.width && att.height && <span>{att.width}x{att.height}</span>}
              <span>{fmtDate(att.create_time)}</span>
              <button
                className={styles.convLink}
                onClick={() => onOpenConv(att.conv_id)}
              >
                {att.conv_title || 'Untitled'}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
