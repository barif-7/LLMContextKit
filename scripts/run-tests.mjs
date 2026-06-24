#!/usr/bin/env node
/**
 * Test runner for the Electron-main importer/parser logic.
 *
 * The test suites only exercise PURE modules (format detection + Claude
 * extraction helpers) which have no native dependencies, so they run under the
 * current Node directly. We compile with `tsc` first so tests import the same
 * emitted JS that ships in dist-electron/.
 *
 * Usage:  node scripts/run-tests.mjs   (or: npm test)
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

console.log('[run-tests] compiling (tsc)…')
try {
  execFileSync('npx', ['tsc'], { cwd: root, stdio: 'inherit' })
} catch (err) {
  console.error('[run-tests] TypeScript compilation failed')
  process.exit(err.status ?? 1)
}

console.log(`[run-tests] running tests with node ${process.version}`)
try {
  execFileSync(process.execPath, ['--test', 'test/*.test.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  })
} catch (err) {
  process.exit(err.status ?? 1)
}
