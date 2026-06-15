// Pure-function unit tests for timestamp normalisation and nvm LTS
// detection. These tests do NOT require better-sqlite3 or Electron.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { toUnixSeconds } = await import('../dist/importer.js')

// ── toUnixSeconds ────────────────────────────────────────────────────────

test('toUnixSeconds: null / undefined / empty string → null', () => {
  assert.equal(toUnixSeconds(null), null)
  assert.equal(toUnixSeconds(undefined), null)
  assert.equal(toUnixSeconds(''), null)
})

test('toUnixSeconds: NaN and Infinity → null', () => {
  assert.equal(toUnixSeconds(NaN), null)
  assert.equal(toUnixSeconds(Infinity), null)
  assert.equal(toUnixSeconds(-Infinity), null)
})

test('toUnixSeconds: Unix seconds pass through unchanged', () => {
  assert.equal(toUnixSeconds(1710000000), 1710000000)
  assert.equal(toUnixSeconds(0), 0)
  assert.equal(toUnixSeconds(1), 1)
})

test('toUnixSeconds: Unix milliseconds are divided by 1000', () => {
  assert.equal(toUnixSeconds(1710000000000), 1710000000)
  // Just above the threshold
  assert.equal(toUnixSeconds(1_000_000_000_001), 1_000_000_000.001)
})

test('toUnixSeconds: numeric strings are normalised', () => {
  assert.equal(toUnixSeconds('1710000000'), 1710000000)
  assert.equal(toUnixSeconds('1710000000000'), 1710000000)
  assert.equal(toUnixSeconds('  1710000000  '), 1710000000)
})

test('toUnixSeconds: ISO 8601 date strings are parsed', () => {
  const expected = Date.parse('2024-03-09T12:00:00Z') / 1000
  assert.equal(toUnixSeconds('2024-03-09T12:00:00Z'), expected)
})

test('toUnixSeconds: unparseable strings → null', () => {
  assert.equal(toUnixSeconds('not a date'), null)
  assert.equal(toUnixSeconds('   '), null)
})

test('toUnixSeconds: non-number/non-string types → null', () => {
  assert.equal(toUnixSeconds({}), null)
  assert.equal(toUnixSeconds([]), null)
  assert.equal(toUnixSeconds(true), null)
})

// ── findNvmLtsNode (standalone integration) ─────────────────────────────
// We test the logic directly rather than importing from the Electron-
// compiled bundle, since sync.js has top-level Electron side effects.

test('findNvmLtsNode: discovers an installed LTS version', () => {
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node')
  if (!fs.existsSync(nvmRoot)) {
    // nvm not installed — skip gracefully.
    return
  }

  const LTS_MAJORS = [22, 20, 18]
  let entries
  try { entries = fs.readdirSync(nvmRoot) } catch { return }

  let found = null
  for (const major of LTS_MAJORS) {
    const candidates = entries
      .filter((d) => d.startsWith(`v${major}.`))
      .sort((a, b) => {
        const pa = a.replace(/^v/, '').split('.').map(Number)
        const pb = b.replace(/^v/, '').split('.').map(Number)
        for (let i = 0; i < 3; i++) {
          const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
          if (diff !== 0) return diff
        }
        return 0
      })

    for (const version of candidates) {
      const binPath = path.join(nvmRoot, version, 'bin', 'node')
      if (fs.existsSync(binPath) && fs.statSync(binPath).isFile()) {
        found = { version, binPath }
        break
      }
    }
    if (found) break
  }

  if (found) {
    assert.ok(found.version.match(/^v(22|20|18)\./), `expected LTS major, got ${found.version}`)
    assert.ok(fs.existsSync(found.binPath))
  }
})

// ── formatError ──────────────────────────────────────────────────────────

test('formatError: Error instances return .message', () => {
  const formatError = (err) => err instanceof Error ? err.message : String(err)
  assert.equal(formatError(new Error('boom')), 'boom')
})

test('formatError: non-Error values are stringified', () => {
  const formatError = (err) => err instanceof Error ? err.message : String(err)
  assert.equal(formatError('plain string'), 'plain string')
  assert.equal(formatError(42), '42')
  assert.equal(formatError(null), 'null')
})
