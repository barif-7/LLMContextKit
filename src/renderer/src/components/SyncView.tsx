import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatGPTAuthStatus, SyncFlags } from '../App'
import styles from './SyncView.module.css'

type SyncMode = 'chatgpt-extension' | 'chatgpt-native' | 'claude-native'

interface Props {
  onSynced: () => Promise<void> | void
}

const DEFAULT_FLAGS: SyncFlags = {
  browserExtensionChatGPT: true,
  nativeChatGPT: false,
  nativeClaude: false,
}

function modeLabel(mode: SyncMode) {
  if (mode === 'chatgpt-extension') return 'ChatGPT via extension'
  if (mode === 'chatgpt-native') return 'ChatGPT via native daemon'
  return 'Claude via native daemon'
}

export function SyncView({ onSynced }: Props) {
  const [flags, setFlags] = useState<SyncFlags>(DEFAULT_FLAGS)
  const [busyMode, setBusyMode] = useState<SyncMode | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<ChatGPTAuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const cancelAuthPoll = useRef(false)

  useEffect(() => {
    window.api.syncFlags().then((next) => setFlags(next))
    window.api.syncStatus().then((status) => {
      if (status?.activeRun?.mode) {
        setLastResult(`Active: ${status.activeRun.mode}`)
      }
    })
    return () => {
      cancelAuthPoll.current = true
    }
  }, [])

  useEffect(() => {
    if (!flags.nativeChatGPT) return
    void refreshAuthStatus()
  }, [flags.nativeChatGPT])

  const enabledModes = useMemo(() => {
    const modes: SyncMode[] = []
    if (flags.browserExtensionChatGPT) modes.push('chatgpt-extension')
    if (flags.nativeChatGPT) modes.push('chatgpt-native')
    if (flags.nativeClaude) modes.push('claude-native')
    return modes
  }, [flags])

  async function updateFlags(patch: Partial<SyncFlags>) {
    setError(null)
    const next = await window.api.setSyncFlags(patch)
    setFlags(next)
  }

  async function run(mode: SyncMode) {
    setError(null)
    setMessage(null)
    setBusyMode(mode)
    try {
      const result = await window.api.runSync(mode)
      if (!result.ok) {
        throw new Error(result.error || result.message || 'Sync failed')
      }
      setLastResult(result.message || modeLabel(mode))
      setMessage(result.message || `${modeLabel(mode)} started`)

      if (mode === 'chatgpt-extension') {
        window.setTimeout(() => {
          void onSynced()
        }, 8000)
      } else {
        await onSynced()
      }
    } catch (err: any) {
      setError(err?.message || 'Sync failed')
    } finally {
      setBusyMode(null)
    }
  }

  async function refreshAuthStatus() {
    try {
      const status = await window.api.chatGPTAuthStatus()
      setAuthStatus(status)
      return status
    } catch (err: any) {
      const status: ChatGPTAuthStatus = {
        debugPort: 9222,
        chromeReachable: false,
        hasChatGPTTarget: false,
        authenticated: false,
        message: err?.message || 'Could not check ChatGPT auth status',
      }
      setAuthStatus(status)
      return status
    }
  }

  async function runNativeAuthFlow() {
    setError(null)
    setMessage('Opening ChatGPT in debug Chrome...')
    setAuthBusy(true)
    cancelAuthPoll.current = false

    try {
      const started = await window.api.startChatGPTAuth()
      if (!started.ok) {
        throw new Error(started.error || started.message || 'Could not open Chrome debug session')
      }

      for (let attempt = 0; attempt < 90; attempt++) {
        if (cancelAuthPoll.current) return
        const status = await refreshAuthStatus()
        if (status.authenticated && status.hasAccessToken) {
          setMessage('ChatGPT is authenticated. Starting native sync...')
          setAuthBusy(false)
          await run('chatgpt-native')
          return
        }
        setMessage(status.message)
        await new Promise((resolve) => window.setTimeout(resolve, 2000))
      }

      setError('Timed out waiting for ChatGPT sign-in. Leave the Chrome window open and try again.')
    } catch (err: any) {
      setError(err?.message || 'Could not start ChatGPT auth flow')
    } finally {
      setAuthBusy(false)
    }
  }

  function cancelNativeAuthFlow() {
    cancelAuthPoll.current = true
    setAuthBusy(false)
    setMessage(null)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h1>Sync</h1>
          <p>Keep the browser extension flow and the native host-driven flow side by side while they are still experimental.</p>
        </div>
      </div>

      <section className={styles.section}>
        <h2>Feature Flags</h2>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={flags.browserExtensionChatGPT}
            onChange={e => void updateFlags({ browserExtensionChatGPT: e.target.checked })}
          />
          <span>
            <strong>ChatGPT browser extension</strong>
            <em>Uses the existing popup/content-script path.</em>
          </span>
        </label>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={flags.nativeChatGPT}
            onChange={e => void updateFlags({ nativeChatGPT: e.target.checked })}
          />
          <span>
            <strong>ChatGPT native daemon</strong>
            <em>Runs the Node/CDP sync flow from the desktop app.</em>
          </span>
        </label>
        <label className={`${styles.toggleRow} ${styles.disabledRow}`}>
          <input
            type="checkbox"
            checked={flags.nativeClaude}
            onChange={e => void updateFlags({ nativeClaude: e.target.checked })}
          />
          <span>
            <strong>Claude native daemon</strong>
            <em>Reserved for the future native adapter.</em>
          </span>
        </label>
      </section>

      <section className={styles.section}>
        <h2>Run Sync</h2>
        <div className={styles.actions}>
          {flags.browserExtensionChatGPT && (
            <button
              className={styles.primaryBtn}
              onClick={() => void run('chatgpt-extension')}
              disabled={busyMode !== null}
            >
              {busyMode === 'chatgpt-extension' ? 'Syncing...' : 'Sync ChatGPT'}
            </button>
          )}
          {flags.nativeChatGPT && (
            <button
              className={styles.primaryBtn}
              onClick={() => void runNativeAuthFlow()}
              disabled={busyMode !== null || authBusy}
            >
              {busyMode === 'chatgpt-native' ? 'Syncing...' : authBusy ? 'Waiting for Sign In...' : 'Sync ChatGPT Native'}
            </button>
          )}
          {flags.nativeChatGPT && (
            <button
              className={styles.secondaryBtn}
              onClick={() => void refreshAuthStatus()}
              disabled={busyMode !== null || authBusy}
            >
              Check ChatGPT Auth
            </button>
          )}
          {authBusy && (
            <button
              className={styles.secondaryBtn}
              onClick={cancelNativeAuthFlow}
              disabled={busyMode !== null}
            >
              Stop Waiting
            </button>
          )}
          {flags.nativeClaude && (
            <button
              className={styles.secondaryBtn}
              onClick={() => void run('claude-native')}
              disabled={busyMode !== null}
            >
              {busyMode === 'claude-native' ? 'Syncing...' : 'Sync Claude'}
            </button>
          )}
          {!enabledModes.length && (
            <div className={styles.emptyState}>Enable at least one flag to expose a sync action.</div>
          )}
        </div>
        {message && <div className={styles.message}>{message}</div>}
        {flags.nativeChatGPT && authStatus && (
          <div className={`${styles.authBox} ${authStatus.authenticated && authStatus.hasAccessToken ? styles.authOk : ''}`}>
            <div className={styles.authLine}>
              <strong>
                {authStatus.authenticated && authStatus.hasAccessToken
                  ? 'Signed in'
                  : authStatus.message.startsWith('DevTools error')
                    ? 'Connection Error'
                    : authStatus.chromeReachable
                      ? 'Waiting for sign-in'
                      : 'Chrome not connected'}
              </strong>
              <span>Port {authStatus.debugPort}</span>
            </div>
            <p>{authStatus.message}</p>
            {authStatus.url && <code>{authStatus.url}</code>}
          </div>
        )}
        {lastResult && <div className={styles.hint}>{lastResult}</div>}
        {error && <div className={styles.error}>{error}</div>}
      </section>

      <section className={styles.section}>
        <h2>Notes</h2>
        <p className={styles.note}>
          The extension flow remains available for comparison. The native ChatGPT flow is the cleaner long-term path because it keeps the sync job in one host process.
        </p>
      </section>
    </div>
  )
}
