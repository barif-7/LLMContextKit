const BATCH_SIZE = 3
const DELAY_MS = 800
const PAGE_LIMIT = 100
const MAX_RETRIES = 5
const BASE_BACKOFF = 2000
const POST_BATCH_SIZE = 25

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getAccessToken() {
  const res = await fetch('/api/auth/session')
  if (!res.ok) throw new Error(`Auth session failed: ${res.status}`)
  const data = await res.json()
  if (!data.accessToken) throw new Error('Not logged in to ChatGPT')
  return data.accessToken
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status === 429) {
        const wait = BASE_BACKOFF * Math.pow(2, attempt)
        console.log(`[historykit] Rate limited, waiting ${wait}ms...`)
        await sleep(wait)
        continue
      }
      if (res.status === 403) {
        throw new Error('Session expired — please log in to ChatGPT')
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      return res
    } catch (err) {
      if (attempt === retries) throw err
      if (err.message.includes('Session expired')) throw err
      const wait = BASE_BACKOFF * Math.pow(2, attempt)
      console.log(
        `[historykit] Retry ${attempt + 1}/${retries} after ${wait}ms: ${err.message}`
      )
      await sleep(wait)
    }
  }
  throw new Error('Exhausted retries')
}

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response)
      }
    })
  })
}

function reportProgress(phase, detail) {
  chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', phase, detail })
}

async function syncChatGPT() {
  try {
    reportProgress('auth', 'Getting access token...')
    const token = await getAccessToken()
    const headers = { Authorization: `Bearer ${token}` }

    reportProgress('check', 'Checking local database...')
    const knownRes = await sendToBackground({ type: 'GET_KNOWN_IDS' })
    const knownIds = knownRes.knownIds || {}

    reportProgress('list', 'Fetching conversation list...')
    const allConvSummaries = []
    let offset = 0
    let total = Infinity

    while (offset < total) {
      const res = await fetchWithRetry(
        `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated`,
        { headers }
      )
      const data = await res.json()
      total = data.total ?? data.items?.length ?? 0
      const items = data.items ?? []
      allConvSummaries.push(...items)
      offset += items.length
      if (items.length === 0) break
      reportProgress(
        'list',
        `Found ${allConvSummaries.length}/${total} conversations...`
      )
      await sleep(DELAY_MS)
    }

    const needsFetch = allConvSummaries.filter((conv) => {
      const localTime = knownIds[conv.id]
      if (localTime == null) return true
      if (conv.update_time == null) return true
      return conv.update_time > localTime
    })

    reportProgress(
      'fetch',
      `${needsFetch.length} conversations need syncing (${allConvSummaries.length - needsFetch.length} already current)`
    )

    if (needsFetch.length === 0) {
      chrome.runtime.sendMessage({
        type: 'SYNC_COMPLETE',
        result: {
          new: 0,
          updated: 0,
          skipped: allConvSummaries.length,
          errors: 0,
          total: allConvSummaries.length,
        },
      })
      return
    }

    const fullConversations = []
    let fetchErrors = 0

    for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
      const batch = needsFetch.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map(async (conv) => {
          try {
            const res = await fetchWithRetry(
              `https://chatgpt.com/backend-api/conversation/${conv.id}`,
              { headers }
            )
            return await res.json()
          } catch (err) {
            console.error(
              `[historykit] Failed to fetch ${conv.id}: ${err.message}`
            )
            fetchErrors++
            return null
          }
        })
      )
      fullConversations.push(...results.filter(Boolean))
      reportProgress(
        'fetch',
        `Fetched ${Math.min(i + BATCH_SIZE, needsFetch.length)}/${needsFetch.length} conversations...`
      )
      if (i + BATCH_SIZE < needsFetch.length) await sleep(DELAY_MS)
    }

    let totalNew = 0
    let totalUpdated = 0
    let totalSkipped = 0
    let totalErrored = 0

    for (let i = 0; i < fullConversations.length; i += POST_BATCH_SIZE) {
      const batch = fullConversations.slice(i, i + POST_BATCH_SIZE)
      reportProgress(
        'import',
        `Importing ${Math.min(i + POST_BATCH_SIZE, fullConversations.length)}/${fullConversations.length}...`
      )

      const { result } = await sendToBackground({
        type: 'POST_IMPORT',
        conversations: batch,
      })

      if (result) {
        totalNew += result.new_count ?? 0
        totalUpdated += result.updated_count ?? 0
        totalSkipped += result.skipped_count ?? 0
        totalErrored += result.errored_count ?? 0
      }
    }

    const summary = {
      new: totalNew,
      updated: totalUpdated,
      skipped: totalSkipped + (allConvSummaries.length - needsFetch.length),
      errors: totalErrored + fetchErrors,
      total: allConvSummaries.length,
    }

    chrome.runtime.sendMessage({ type: 'SYNC_COMPLETE', result: summary })
  } catch (err) {
    console.error('[historykit] Sync failed:', err)
    chrome.runtime.sendMessage({ type: 'SYNC_ERROR', error: err.message })
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_SYNC') {
    syncChatGPT()
    sendResponse({ started: true })
  }
  return false
})
