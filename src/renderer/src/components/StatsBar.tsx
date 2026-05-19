import type { Stats } from '../App'
import styles from './StatsBar.module.css'

export function StatsBar({ stats }: { stats: Stats }) {
  const hasChatGPT = stats.bySource.chatgpt.messages > 0
  const hasClaude = stats.bySource.claude.messages > 0
  const hasBothSources = hasChatGPT && hasClaude

  return (
    <div className={styles.bar}>
      <Stat
        label={hasBothSources
          ? `${stats.bySource.chatgpt.messages.toLocaleString()} ChatGPT · ${stats.bySource.claude.messages.toLocaleString()} Claude`
          : 'Messages'}
        value={stats.messages.toLocaleString()}
      />
      <div className={styles.sep} />
      <Stat label="Conversations" value={stats.conversations.toLocaleString()} />
      <div className={styles.sep} />
      <Stat label="Code blocks" value={stats.withCode.toLocaleString()} accent="amber" />
      <div className={styles.sep} />
      <Stat label="With images" value={stats.withImages.toLocaleString()} accent="blue" />
      <div className={styles.sep} />
      <Stat label="Words indexed" value={(stats.totalWords / 1000).toFixed(0) + 'k'} accent="violet" />
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className={styles.stat}>
      <span className={`${styles.value} ${accent ? styles[accent] : ''}`}>{value}</span>
      <span className={styles.label}>{label}</span>
    </div>
  )
}
