#!/usr/bin/env node

import fs from 'fs'

const DEFAULT_DEBUG_PORT = 9222
const DEFAULT_IMPORT_URL = 'http://127.0.0.1:8765'
const DEFAULT_PAGE_LIMIT = 100
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_DELAY_MS = 250
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BACKOFF_MS = 1500
const DEFAULT_CONVERSATIONS_FILE = process.env.HISTORYKIT_CONVERSATIONS_FILE || ''

function parseArgs(argv) {
  const out = {
    debugPort: DEFAULT_DEBUG_PORT,
    importUrl: DEFAULT_IMPORT_URL,
    pageLimit: DEFAULT_PAGE_LIMIT,
    batchSize: DEFAULT_BATCH_SIZE,
    delayMs: DEFAULT_DELAY_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    backoffMs: DEFAULT_BACKOFF_MS,
    conversationsFile: DEFAULT_CONVERSATIONS_FILE,
    force: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }

    const [key, rawValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null]
    const next = rawValue ?? argv[++i]

    switch (key) {
      case '--debug-port':
        out.debugPort = Number(next)
        break
      case '--import-url':
        out.importUrl = String(next)
        break
      case '--page-limit':
        out.pageLimit = Number(next)
        break
      case '--batch-size':
        out.batchSize = Number(next)
        break
      case '--delay-ms':
        out.delayMs = Number(next)
        break
      case '--max-retries':
        out.maxRetries = Number(next)
        break
      case '--backoff-ms':
        out.backoffMs = Number(next)
        break
      case '--conversations-file':
        out.conversationsFile = String(next)
        break
      case '--force':
        out.force = true
        if (rawValue === null) i--
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  for (const [name, value] of Object.entries(out)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid value for ${name}`)
    }
  }

  return out
}

function usage() {
  return [
    'Usage:',
    '  node scripts/sync-chatgpt-history.mjs [options]',
    '',
    'Options:',
    `  --debug-port <n>   Chrome remote debugging port (default: ${DEFAULT_DEBUG_PORT})`,
    `  --import-url <url> HistoryKit importer URL (default: ${DEFAULT_IMPORT_URL})`,
    `  --page-limit <n>   ChatGPT conversations page size (default: ${DEFAULT_PAGE_LIMIT})`,
    `  --batch-size <n>   Conversations fetched per browser batch (default: ${DEFAULT_BATCH_SIZE})`,
    `  --delay-ms <n>     Delay between page fetch batches (default: ${DEFAULT_DELAY_MS})`,
    `  --max-retries <n>  Retry count for ChatGPT requests (default: ${DEFAULT_MAX_RETRIES})`,
    `  --backoff-ms <n>   Retry backoff base in milliseconds (default: ${DEFAULT_BACKOFF_MS})`,
    '  --conversations-file <path>  Reimport a local conversations.json instead of ChatGPT',
    '  --force           Fetch and re-import all conversations, even if already current',
    '  -h, --help         Show this help',
  ].join('\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

function toUnixSeconds(value) {
  if (value == null || value === '') return null

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 1_000_000_000_000 ? value / 1000 : value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric
    }

    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed / 1000 : null
  }

  return null
}

function normalizeConversationTimestamps(conv) {
  if (!conv || typeof conv !== 'object') return conv

  conv.create_time = toUnixSeconds(conv.create_time)
  conv.update_time = toUnixSeconds(conv.update_time)

  if (conv.mapping && typeof conv.mapping === 'object') {
    for (const node of Object.values(conv.mapping)) {
      const msg = node?.message
      if (msg && typeof msg === 'object') {
        msg.create_time = toUnixSeconds(msg.create_time)
      }
    }
  }

  return conv
}

async function fetchJson(url, options) {
  let res
  try {
    res = await fetch(url, options)
  } catch (err) {
    throw new Error(`Request failed for ${url}: ${formatError(err)}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `: ${body}` : ''}`)
  }
  return await res.json()
}

async function fetchText(url, options) {
  let res
  try {
    res = await fetch(url, options)
  } catch (err) {
    throw new Error(`Request failed for ${url}: ${formatError(err)}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `: ${body}` : ''}`)
  }
  return await res.text()
}

async function getChromeTargets(debugPort) {
  const url = `http://127.0.0.1:${debugPort}/json/list`
  let targets
  try {
    targets = await fetchJson(url)
  } catch (err) {
    throw new Error(
      `Could not reach Chrome DevTools on ${url}. Start Chrome with --remote-debugging-port=${debugPort} and open an authenticated ChatGPT tab. ${formatError(err)}`
    )
  }
  if (!Array.isArray(targets)) {
    throw new Error(`Unexpected Chrome target response from ${url}`)
  }
  return targets
}

function pickChatGPTTarget(targets) {
  const pageTargets = targets.filter((target) => target?.type === 'page' && target?.webSocketDebuggerUrl)
  const scored = pageTargets
    .map((target) => {
      const url = String(target.url || '')
      const title = String(target.title || '')
      let score = 0
      if (url.includes('chatgpt.com')) score += 10
      if (url.includes('chat.openai.com')) score += 8
      if (title.toLowerCase().includes('chatgpt')) score += 4
      if (title.toLowerCase().includes('codex')) score += 2
      if (url.startsWith('https://chatgpt.com/')) score += 4
      return { target, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored[0]?.target ?? null
}

async function connectDebugger(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${webSocketDebuggerUrl}`)), { once: true })
  })

  let nextId = 0
  const pending = new Map()

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
    const message = JSON.parse(raw)
    if (message.id != null) {
      const record = pending.get(message.id)
      if (!record) return
      pending.delete(message.id)
      if (message.error) {
        record.reject(new Error(message.error.message || 'Chrome DevTools Protocol error'))
      } else {
        record.resolve(message.result ?? {})
      }
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  async function close() {
    for (const { reject } of pending.values()) reject(new Error('Debugger closed'))
    pending.clear()
    socket.close()
  }

  return { send, close }
}

async function pageEvaluate(send, fn, ...args) {
  const serializedArgs = args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg))).join(',')
  const expression = `(${fn.toString()})(${serializedArgs})`
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })

  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Page evaluation failed'
    throw new Error(message)
  }

  return result.result?.value
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  if (options.conversationsFile) {
    const data = JSON.parse(fs.readFileSync(options.conversationsFile, 'utf8'))
    const conversations = Array.isArray(data)
      ? data
      : Array.isArray(data?.conversations)
        ? data.conversations
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.items)
            ? data.items
            : null

    if (!conversations) {
      throw new Error(`Unsupported conversations file format: ${options.conversationsFile}`)
    }

    const normalizedConversations = conversations.map(normalizeConversationTimestamps)
    const result = await fetchJson(`${options.importUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: normalizedConversations, force: true }),
    })

    console.log(
      JSON.stringify(
        {
          source: options.conversationsFile,
          imported: normalizedConversations.length,
          new: Number(result.new_count || 0),
          updated: Number(result.updated_count || 0),
          skipped: Number(result.skipped_count || 0),
          errors: Number(result.errored_count || 0),
          messages: Number(result.message_count || 0),
          code_blocks: Number(result.code_block_count || 0),
          attachments: Number(result.attachment_count || 0),
          file_contents: Number(result.file_content_count || 0),
          links: Number(result.link_count || 0),
          memories: Number(result.memory_count || 0),
        },
        null,
        2
      )
    )
    return
  }

  const targets = await getChromeTargets(options.debugPort)
  const target = pickChatGPTTarget(targets)
  if (!target) {
    throw new Error(
      `No ChatGPT page found on Chrome debug port ${options.debugPort}. Open an authenticated ChatGPT tab first.`
    )
  }

  const debuggerClient = await connectDebugger(target.webSocketDebuggerUrl)
  try {
    await debuggerClient.send('Runtime.enable')
    await debuggerClient.send('Page.enable')

    console.log(`[sync] connected to ${target.title || target.url}`)

    const session = await pageEvaluate(debuggerClient.send, async () => {
      const res = await fetch('/api/auth/session', { credentials: 'include' })
      if (!res.ok) {
        throw new Error(`Auth session failed: HTTP ${res.status}`)
      }
      const data = await res.json()
      if (!data?.accessToken) {
        throw new Error('ChatGPT session is not authenticated')
      }
      return data
    })

    const accessToken = session.accessToken
    const headers = { Authorization: `Bearer ${accessToken}` }

    const knownIds = await fetchJson(`${options.importUrl}/known-ids`)
    console.log(`[sync] loaded ${Object.keys(knownIds).length} local conversation ids`)

    const summaries = await pageEvaluate(
      debuggerClient.send,
      async ({ pageLimit, maxRetries, backoffMs, headers }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

        async function fetchWithRetry(url, requestInit) {
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const res = await fetch(url, requestInit)
              if (res.status === 429) {
                if (attempt === maxRetries) {
                  throw new Error(`HTTP 429 for ${url}`)
                }
                await sleep(backoffMs * 2 ** attempt)
                continue
              }
              if (res.status === 403) {
                throw new Error('ChatGPT session expired')
              }
              if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
              }
              return res
            } catch (err) {
              if (attempt === maxRetries) throw err
              await sleep(backoffMs * 2 ** attempt)
            }
          }
          throw new Error(`Exhausted retries for ${url}`)
        }

        const all = []
        let offset = 0
        let total = Infinity

        while (offset < total) {
          const url = new URL('https://chatgpt.com/backend-api/conversations')
          url.searchParams.set('offset', String(offset))
          url.searchParams.set('limit', String(pageLimit))
          url.searchParams.set('order', 'updated')

          const res = await fetchWithRetry(url.toString(), { headers })
          const data = await res.json()
          const items = Array.isArray(data.items) ? data.items : []

          if (Number.isFinite(data.total)) {
            total = Number(data.total)
          } else if (items.length < pageLimit) {
            total = offset + items.length
          }

          all.push(...items)
          offset += items.length

          if (items.length === 0) break
          if (items.length < pageLimit && !Number.isFinite(data.total)) break
          await sleep(250)
        }

        return all
      },
      {
        pageLimit: options.pageLimit,
        maxRetries: options.maxRetries,
        backoffMs: options.backoffMs,
        headers,
      }
    )

    if (!Array.isArray(summaries) || summaries.length === 0) {
      console.log('[sync] no conversations returned by ChatGPT')
      return
    }

    let newCount = 0
    let changedCount = 0
    let unknownTimestampCount = 0
    let currentCount = 0

    const needsFetch = options.force ? summaries : summaries.filter((conv) => {
      const localTime = knownIds[conv.id]
      if (localTime == null) {
        newCount++
        return true
      }

      const remoteTime = toUnixSeconds(conv.update_time)
      const localNumericTime = toUnixSeconds(localTime)
      if (remoteTime == null || localNumericTime == null) {
        unknownTimestampCount++
        return true
      }

      if (remoteTime > localNumericTime) {
        changedCount++
        return true
      }

      currentCount++
      return false
    })

    console.log(
      `[sync] listed ${summaries.length} conversations, ${needsFetch.length} need refresh, ${summaries.length - needsFetch.length} already current`
    )
    if (!options.force) {
      console.log(
        `[sync] refresh plan: ${newCount} new, ${changedCount} changed, ${unknownTimestampCount} unknown timestamp, ${currentCount} current`
      )
    }

    let totalImported = 0
    let totalNew = 0
    let totalUpdated = 0
    let totalSkipped = summaries.length - needsFetch.length
    let totalErrored = 0
    let totalMessages = 0
    let totalCodeBlocks = 0
    let totalAttachments = 0
    let totalFileContents = 0
    let totalLinks = 0
    let totalMemories = 0

    async function importFetchedBatch(conversations) {
      if (conversations.length === 0) return

      const normalized = conversations.map(normalizeConversationTimestamps)
      const result = await fetchJson(`${options.importUrl}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversations: normalized, force: options.force }),
      })

      totalImported += normalized.length
      totalNew += Number(result.new_count || 0)
      totalUpdated += Number(result.updated_count || 0)
      totalSkipped += Number(result.skipped_count || 0)
      totalErrored += Number(result.errored_count || 0)
      totalMessages += Number(result.message_count || 0)
      totalCodeBlocks += Number(result.code_block_count || 0)
      totalAttachments += Number(result.attachment_count || 0)
      totalFileContents += Number(result.file_content_count || 0)
      totalLinks += Number(result.link_count || 0)
      totalMemories += Number(result.memory_count || 0)
    }

    for (let i = 0; i < needsFetch.length; i += options.batchSize) {
      const batch = needsFetch.slice(i, i + options.batchSize)
      const ids = batch.map((conv) => conv.id)

      const fetched = await pageEvaluate(
        debuggerClient.send,
        async ({ ids, headers, maxRetries, backoffMs }) => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

          async function fetchWithRetry(url, requestInit) {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              try {
                const res = await fetch(url, requestInit)
                if (res.status === 429) {
                  if (attempt === maxRetries) {
                    throw new Error(`HTTP 429 for ${url}`)
                  }
                  await sleep(backoffMs * 2 ** attempt)
                  continue
                }
                if (res.status === 403) {
                  throw new Error('ChatGPT session expired')
                }
                if (!res.ok) {
                  throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
                }
                return res
              } catch (err) {
                if (attempt === maxRetries) throw err
                await sleep(backoffMs * 2 ** attempt)
              }
            }
            throw new Error(`Exhausted retries for ${url}`)
          }

          return await Promise.all(
            ids.map(async (id) => {
              const url = `https://chatgpt.com/backend-api/conversation/${id}`
              try {
                const res = await fetchWithRetry(url, { headers })
                return { id, conversation: await res.json() }
              } catch (err) {
                return { id, error: err?.message || String(err) }
              }
            })
          )
        },
        {
          ids,
          headers,
          maxRetries: options.maxRetries,
          backoffMs: options.backoffMs,
        }
      )

      const fetchedConversations = []
      for (const item of fetched) {
        if (item?.conversation) {
          fetchedConversations.push(item.conversation)
        } else {
          totalErrored += 1
          console.error(`[sync] failed to fetch ${item?.id}: ${item?.error || 'unknown error'}`)
        }
      }

      await importFetchedBatch(fetchedConversations)

      console.log(
        `[sync] fetched ${Math.min(i + options.batchSize, needsFetch.length)}/${needsFetch.length} changed conversations, imported ${totalImported}`
      )

      if (i + options.batchSize < needsFetch.length) {
        await sleep(options.delayMs)
      }
    }

    const summary = {
      listed: summaries.length,
      refreshed: needsFetch.length,
      imported: totalImported,
      new: totalNew,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrored,
      messages: totalMessages,
      code_blocks: totalCodeBlocks,
      attachments: totalAttachments,
      file_contents: totalFileContents,
      links: totalLinks,
      memories: totalMemories,
    }

    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await debuggerClient.close().catch(() => {})
  }
}

main().catch((err) => {
  process.stderr.write(`[sync] fatal: ${formatError(err)}\n`)
  process.exitCode = 1
})
