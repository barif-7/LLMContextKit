import { useState } from 'react'
import type { Message } from '../App'
import { MessageCard } from './MessageCard'
import styles from './ResultsList.module.css'

interface Props {
  results: Message[]
  query: string
  onSelect: (msg: Message) => void
  selectedId?: string
}

export function ResultsList({ results, query, onSelect, selectedId }: Props) {
  if (results.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="13" cy="13" r="8"/><path d="M19 19l5 5"/>
            <path d="M10 13h6M13 10v6"/>
          </svg>
        </div>
        <p>No messages match your search</p>
        <span>Try different keywords or adjust the filters</span>
      </div>
    )
  }

  return (
    <div className={styles.list}>
      {results.slice(0, 300).map(msg => (
        <MessageCard
          key={msg.id}
          message={msg}
          query={query}
          isSelected={msg.id === selectedId}
          onSelect={onSelect}
        />
      ))}
      {results.length > 300 && (
        <div className={styles.truncated}>
          Showing 300 of {results.length.toLocaleString()} results — refine your search to narrow down
        </div>
      )}
    </div>
  )
}
