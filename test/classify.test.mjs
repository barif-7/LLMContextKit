// Pure-function tests for export format classification.
// No Electron / better-sqlite3 required — these run under any Node.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { classifyExport, detectFormat } = await import('../dist-electron/format-detector.js')

function fixture(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf-8'))
}

test('classifyExport: ChatGPT conversations array', () => {
  const c = classifyExport(fixture('chatgpt/conversations.json'))
  assert.deepEqual(c, { source: 'chatgpt', kind: 'conversations' })
  assert.equal(detectFormat(fixture('chatgpt/conversations.json')), 'chatgpt')
})

test('classifyExport: Claude conversations array', () => {
  const c = classifyExport(fixture('claude/conversations-array.json'))
  assert.deepEqual(c, { source: 'claude', kind: 'conversations' })
})

test('classifyExport: single Claude conversation', () => {
  const c = classifyExport(fixture('claude/single-conversation.json'))
  assert.deepEqual(c, { source: 'claude', kind: 'conversations' })
})

test('classifyExport: Claude design chat', () => {
  const c = classifyExport(fixture('claude/design-chat.json'))
  assert.deepEqual(c, { source: 'claude', kind: 'design_chat' })
})

test('classifyExport: Claude project docs', () => {
  const c = classifyExport(fixture('claude/project-docs.json'))
  assert.deepEqual(c, { source: 'claude', kind: 'project' })
})

test('classifyExport: Claude memories', () => {
  const c = classifyExport(fixture('claude/memories.json'))
  assert.deepEqual(c, { source: 'claude', kind: 'memory' })
})

test('classifyExport: attachment conversation classifies as claude conversations', () => {
  const c = classifyExport(fixture('claude/attachments-extracted-content.json'))
  assert.deepEqual(c, { source: 'claude', kind: 'conversations' })
})

test('classifyExport: malformed / unknown shape', () => {
  const c = classifyExport(fixture('claude/malformed-empty.json'))
  assert.deepEqual(c, { source: 'unknown', kind: 'unknown' })
  assert.equal(detectFormat(fixture('claude/malformed-empty.json')), 'unknown')
})

test('classifyExport: empty / primitive inputs are unknown', () => {
  assert.deepEqual(classifyExport(null), { source: 'unknown', kind: 'unknown' })
  assert.deepEqual(classifyExport([]), { source: 'unknown', kind: 'unknown' })
  assert.deepEqual(classifyExport('nope'), { source: 'unknown', kind: 'unknown' })
})
