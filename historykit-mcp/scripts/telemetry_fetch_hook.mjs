// Preload with: node --import ./scripts/telemetry_fetch_hook.mjs dist/index_embeddings.js
// Wraps global fetch to record Ollama embed-call latency/chars without touching production code.
// Writes ${TELEMETRY_DIR}/embed-calls.json on process exit.
import fs from 'fs'
import path from 'path'

const dir = process.env.TELEMETRY_DIR
if (!dir) {
  console.error('[telemetry] TELEMETRY_DIR not set; hook disabled')
} else {
  fs.mkdirSync(dir, { recursive: true })

  const latencies = []
  let okCalls = 0
  let okChars = 0
  const failures = []
  let peakRss = process.memoryUsage().rss
  const startedAt = new Date().toISOString()
  const t0 = performance.now()

  const rssTimer = setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peakRss) peakRss = rss
  }, 1000)
  rssTimer.unref()

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('/api/embeddings')) return origFetch(url, opts)

    let promptChars = 0
    try { promptChars = JSON.parse(opts?.body ?? '{}').prompt?.length ?? 0 } catch {}

    const callStart = performance.now()
    try {
      const res = await origFetch(url, opts)
      const ms = performance.now() - callStart
      if (res.ok) {
        latencies.push(ms)
        okCalls += 1
        okChars += promptChars
      } else {
        failures.push({ kind: `http_${res.status}`, promptChars, ms: Math.round(ms) })
      }
      return res
    } catch (err) {
      failures.push({ kind: 'fetch_error', detail: String(err).slice(0, 200), promptChars })
      throw err
    }
  }

  process.on('exit', () => {
    const sorted = [...latencies].sort((a, b) => a - b)
    const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null
    const wallSeconds = (performance.now() - t0) / 1000
    const summary = {
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      wall_clock_seconds: Number(wallSeconds.toFixed(1)),
      embed_calls_ok: okCalls,
      embed_chars_ok: okChars,
      calls_per_sec: Number((okCalls / wallSeconds).toFixed(2)),
      chars_per_sec: Number((okChars / wallSeconds).toFixed(0)),
      latency_ms: sorted.length ? {
        min: Number(sorted[0].toFixed(1)),
        median: Number(pct(0.5).toFixed(1)),
        p95: Number(pct(0.95).toFixed(1)),
        max: Number(sorted[sorted.length - 1].toFixed(1)),
      } : null,
      failures_count: failures.length,
      failures_sample: failures.slice(0, 20),
      peak_rss_bytes: peakRss,
    }
    fs.writeFileSync(path.join(dir, 'embed-calls.json'), JSON.stringify(summary, null, 2))
  })
}
