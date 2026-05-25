const HISTORYKIT_URL = 'http://127.0.0.1:8765'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Daily alarm ──────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('daily-sync', {
    delayInMinutes: 1,
    periodInMinutes: 60 * 24,
  })
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'daily-sync') {
    await triggerSync('alarm')
  }
})

// ── Long-poll for desktop app triggers ───────────────────────

async function listenForTriggers() {
  while (true) {
    try {
      const res = await fetch(`${HISTORYKIT_URL}/sync-instruction`)
      const { action } = await res.json()
      if (action === 'sync') {
        await triggerSync('desktop_app')
      }
    } catch {
      await sleep(5000)
    }
  }
}

listenForTriggers()

// ── Message handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_KNOWN_IDS') {
    fetch(`${HISTORYKIT_URL}/known-ids`)
      .then((res) => res.json())
      .then((knownIds) => sendResponse({ knownIds }))
      .catch((err) => sendResponse({ knownIds: {}, error: err.message }))
    return true
  }

  if (msg.type === 'POST_IMPORT') {
    fetch(`${HISTORYKIT_URL}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: msg.conversations }),
    })
      .then((res) => res.json())
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ result: null, error: err.message }))
    return true
  }

  if (msg.type === 'SYNC_PROGRESS') {
    chrome.action.setBadgeText({ text: '...' })
    chrome.action.setBadgeBackgroundColor({ color: '#4A90D9' })
    return false
  }

  if (msg.type === 'SYNC_COMPLETE') {
    chrome.action.setBadgeText({ text: '' })
    chrome.action.setTitle({ title: 'historykit sync' })
    chrome.storage.local.set({
      last_sync_at: Date.now(),
      last_sync_result: msg.result,
    })
    return false
  }

  if (msg.type === 'SYNC_ERROR') {
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#D94A4A' })
    chrome.action.setTitle({ title: `historykit error: ${msg.error}` })
    chrome.storage.local.set({
      last_sync_error: msg.error,
      last_sync_error_at: Date.now(),
    })
    return false
  }

  if (msg.type === 'TRIGGER_SYNC') {
    triggerSync('popup')
    sendResponse({ ok: true })
    return false
  }

  return false
})

// ── Trigger sync ─────────────────────────────────────────────

async function triggerSync(source) {
  console.log(`[historykit] Sync triggered by: ${source}`)

  try {
    await fetch(`${HISTORYKIT_URL}/health`)
  } catch {
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#D94A4A' })
    chrome.action.setTitle({ title: 'historykit not running' })
    console.warn('[historykit] Server not running')
    return
  }

  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' })
  let tab

  if (tabs.length > 0) {
    tab = tabs[0]
  } else {
    tab = await chrome.tabs.create({
      url: 'https://chatgpt.com/',
      active: false,
    })
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener)
          resolve()
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
    })
    await sleep(2000)
  }

  chrome.action.setBadgeText({ text: '...' })
  chrome.action.setBadgeBackgroundColor({ color: '#4A90D9' })

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_SYNC' })
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      })
      await sleep(500)
      await chrome.tabs.sendMessage(tab.id, { type: 'START_SYNC' })
    } catch (err) {
      console.error('[historykit] Could not start sync:', err.message)
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: '#D94A4A' })
      chrome.action.setTitle({
        title: 'Could not connect to ChatGPT tab',
      })
    }
  }
}
