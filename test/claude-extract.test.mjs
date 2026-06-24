// Pure-function tests for Claude message/design-file extraction helpers.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const {
  extractMessageText,
  normalizeRole,
  extractClaudeDesignFiles,
  normalizeClaudeData,
  collectAttachments,
} = await import('../dist-electron/importers/claude-extract.js')
const { extractCodeBlocks, extractLinks } = await import('../dist-electron/importers/shared.js')

function fixture(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf-8'))
}

test('extractMessageText: chat_messages text field', () => {
  assert.equal(extractMessageText({ text: 'hello' }), 'hello')
})

test('extractMessageText: design_chat content.content string', () => {
  assert.equal(extractMessageText({ content: { content: 'build it' } }), 'build it')
})

test('extractMessageText: design_chat contentBlocks text + thinking', () => {
  const msg = { content: { contentBlocks: [
    { type: 'thinking', text: 'reasoning' },
    { type: 'text', text: 'answer' },
  ] } }
  assert.equal(extractMessageText(msg), 'reasoning\nanswer')
})

test('extractMessageText: design_chat tool_call + error blocks are not dropped', () => {
  // Real design-chat assistant turns often have empty text/thinking and carry
  // their payload in tool_call / error blocks. These must still produce text.
  const msg = { content: { content: '', contentBlocks: [
    { type: 'thinking', text: '' },
    { type: 'tool_call', toolCall: { name: 'write_file', input: { content: '...' }, output: 'Wrote 11253 characters to styles.css' } },
    { type: 'error', message: "You've hit your Claude Design usage limit" },
  ] } }
  const text = extractMessageText(msg)
  assert.ok(text.includes('[write_file] Wrote 11253 characters to styles.css'), text)
  assert.ok(text.includes('Claude Design usage limit'), text)
})

test('extractMessageText: tool_call with no output falls back to input preview', () => {
  const msg = { content: { contentBlocks: [
    { type: 'tool_call', toolCall: { name: 'questions_v2', input: { questions: ['scope?'] } } },
  ] } }
  const text = extractMessageText(msg)
  assert.ok(text.startsWith('[questions_v2]'), text)
  assert.ok(text.includes('scope?'), text)
})

test('extractMessageText: empty top-level text falls through to content', () => {
  // conversations.json messages with empty text but populated content blocks.
  const msg = { text: '', content: [{ type: 'text', text: 'real content' }] }
  assert.equal(extractMessageText(msg), 'real content')
})

test('normalizeRole: human -> user, assistant -> assistant, role field, fallback', () => {
  assert.equal(normalizeRole({ sender: 'human' }), 'user')
  assert.equal(normalizeRole({ sender: 'assistant' }), 'assistant')
  assert.equal(normalizeRole({ role: 'user' }), 'user')
  assert.equal(normalizeRole({}), 'unknown')
})

test('extractCodeBlocks: parses fenced blocks with language', () => {
  const blocks = extractCodeBlocks('intro\n```ts\nconst x = 1\n```\nend')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].lang, 'ts')
  assert.equal(blocks[0].code, 'const x = 1')
})

test('extractLinks: extracts urls outside code fences', () => {
  const links = extractLinks('see https://example.com/docs and ```\nhttps://ignored.com\n```')
  assert.equal(links.length, 1)
  assert.equal(links[0].url, 'https://example.com/docs')
  assert.equal(links[0].domain, 'example.com')
})

test('normalizeClaudeData: array filters to conversations', () => {
  const convs = normalizeClaudeData(fixture('claude/conversations-array.json'))
  assert.equal(convs.length, 2)
})

test('normalizeClaudeData: single object wrapped in array', () => {
  const convs = normalizeClaudeData(fixture('claude/single-conversation.json'))
  assert.equal(convs.length, 1)
})

test('extractClaudeDesignFiles: reconstructs write_file tool call', () => {
  const conv = fixture('claude/design-chat.json')
  const msg = conv.messages[1]
  const rows = extractClaudeDesignFiles(conv, msg, msg.uuid)
  const write = rows.find((r) => r.operation === 'write_file')
  assert.ok(write, 'expected a write_file row')
  assert.equal(write.file_path, 'src/components/Search.tsx')
  assert.equal(write.file_name, 'Search.tsx')
  assert.equal(write.file_type, 'tsx')
  assert.equal(write.project_name, 'Canvas')
  assert.equal(write.project_uuid, 'proj-canvas')
  assert.match(write.content, /export const Search/)
})

test('collectAttachments + extracted_content present on attachment fixture', () => {
  const conv = fixture('claude/attachments-extracted-content.json')
  const msg = conv.chat_messages[0]
  const atts = collectAttachments(msg)
  assert.equal(atts.length, 1)
  assert.equal(atts[0].extracted_content, 'Quarterly results were strong.')
})
