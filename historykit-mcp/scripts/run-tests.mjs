#!/usr/bin/env node
/**
 * Test runner that auto-selects an nvm LTS Node when the current Node
 * version doesn't have native bindings for better-sqlite3.
 *
 * Usage:  node scripts/run-tests.mjs
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mcpRoot = path.resolve(__dirname, '..')

// ── 1. Probe whether better-sqlite3 loads with the current Node ──────────
function betterSqlite3Works() {
  try {
    const out = execFileSync(process.execPath, [
      '--input-type=module', '-e',
      "import Database from 'better-sqlite3'; new Database(':memory:'); console.log('ok')",
    ], { cwd: mcpRoot, stdio: 'pipe', encoding: 'utf8' })
    return out.trim() === 'ok'
  } catch {
    return false
  }
}

// ── 2. Find an nvm LTS Node that has compiled bindings ───────────────────
function findLtsNode() {
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node')
  if (!fs.existsSync(nvmRoot)) return null

  const LTS_MAJORS = [22, 20, 18]
  let entries
  try { entries = fs.readdirSync(nvmRoot) } catch { return null }

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
        // Check that better-sqlite3 loads AND can create a DB under this Node.
        try {
          const out = execFileSync(binPath, [
            '--input-type=module', '-e',
            "import Database from 'better-sqlite3'; new Database(':memory:'); console.log('ok')",
          ], { cwd: mcpRoot, stdio: 'pipe', encoding: 'utf8' })
          if (out.trim() === 'ok') return { path: binPath, version }
        } catch {
          continue
        }
      }
    }
  }
  return null
}

// ── 3. Run ───────────────────────────────────────────────────────────────
const args = ['--test', 'test/*.test.mjs']
let nodeBin = process.execPath
let label = `node v${process.version}`

if (!betterSqlite3Works()) {
  const lts = findLtsNode()
  if (!lts) {
    console.error(
      `[run-tests] better-sqlite3 native binding missing for Node v${process.version}\n` +
      `            Install an LTS Node via nvm (nvm install 22) and rebuild:\n` +
      `            cd historykit-mcp && npm rebuild better-sqlite3`
    )
    process.exit(1)
  }
  nodeBin = lts.path
  label = `nvm ${lts.version}`
  console.log(`[run-tests] better-sqlite3 not available on Node v${process.version}, switching to ${label}`)
}

console.log(`[run-tests] running tests with ${label} (${nodeBin})`)

try {
  execFileSync(nodeBin, args, {
    cwd: mcpRoot,
    stdio: 'inherit',
    env: { ...process.env },
  })
} catch (err) {
  process.exit(err.status ?? 1)
}
