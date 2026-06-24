// Pure, dependency-free helpers shared across importers.
//
// IMPORTANT: this module must NOT import electron, better-sqlite3, or any other
// native/runtime dependency. Keeping it pure lets the parsing logic be unit
// tested under plain Node (see test/*.test.mjs) without a database or Electron.

export interface CodeBlock {
  lang: string
  code: string
}

export interface LinkMeta {
  url: string
  domain: string
}

const CODE_FENCE_RE = /```(\w*)\r?\n?([\s\S]*?)```/g
const URL_RE = /https?:\/\/[^\s<>"')\]},;]+/g

/** Normalise an ISO date string (or undefined) to Unix seconds. */
export function toUnixSeconds(iso: string | undefined | null): number | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed / 1000 : null
}

/** Count whitespace-delimited words in a string. */
export function wordCount(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}

/** Extract fenced ``` code blocks from text. */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const codeBlocks: CodeBlock[] = []
  if (!text) return codeBlocks
  let match: RegExpExecArray | null
  CODE_FENCE_RE.lastIndex = 0
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: match[1].trim() || 'text', code: match[2].trim() })
  }
  return codeBlocks
}

/** Extract de-duplicated http(s) links (ignoring those inside code fences). */
export function extractLinks(text: string): LinkMeta[] {
  if (!text) return []
  const stripped = text.replace(CODE_FENCE_RE, '')
  const seen = new Set<string>()
  const links: LinkMeta[] = []
  let match: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(stripped)) !== null) {
    const url = match[0].replace(/[.)]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    let domain = ''
    try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { domain = '' }
    links.push({ url, domain })
  }
  return links
}

export function normalizeFilePath(value: string | null | undefined): string {
  const trimmed = String(value || '').trim()
  return trimmed || 'untitled'
}

export function fileNameFromPath(filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || normalized
}

export function inferFileType(filePath: string): string | null {
  const name = fileNameFromPath(filePath)
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return null
  return name.slice(dot + 1).toLowerCase()
}
