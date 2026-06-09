import type { Stats, AppView } from '../App'
import styles from './StatsBar.module.css'

interface Props {
  stats: Stats
  onNavigate: (view: AppView) => void
}

export function StatsBar({ stats, onNavigate }: Props) {
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
      <Stat label="Code blocks" value={stats.withCode.toLocaleString()} accent="amber" />
      <div className={styles.sep} />
      <Stat label="Images" value={stats.withImages.toLocaleString()} accent="blue" />
      {stats.withLinks > 0 && (
        <>
          <div className={styles.sep} />
          <Stat
            label="Links"
            value={stats.withLinks.toLocaleString()}
            accent="teal"
            onClick={() => onNavigate('profile')}
          />
        </>
      )}
      {stats.withFiles > 0 && (
        <>
          <div className={styles.sep} />
          <Stat
            label="Files"
            value={stats.withFiles.toLocaleString()}
            accent="violet"
            onClick={() => onNavigate('profile')}
          />
        </>
      )}
      {stats.withMemories > 0 && (
        <>
          <div className={styles.sep} />
          <Stat
            label="Memories"
            value={stats.withMemories.toLocaleString()}
            accent="green"
            onClick={() => onNavigate('profile')}
          />
        </>
      )}
    </div>
  )
}

function Stat({ label, value, accent, onClick }: { label: string; value: string; accent?: string; onClick?: () => void }) {
  return (
    <div
      className={`${styles.stat} ${onClick ? styles.clickable : ''}`}
      onClick={onClick}
    >
      <span className={`${styles.value} ${accent ? styles[accent] : ''}`}>{value}</span>
      <span className={styles.label}>{label}</span>
    </div>
  )
}
