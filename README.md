# HistoryKit

> Local ChatGPT **and Claude** conversation search. Fast, private, offline.

ChatGPT and Claude both ship slow, shallow search that misses most of what you've written. HistoryKit imports your exports — ChatGPT's `conversations.json` and every surface of a Claude export — indexes everything into a local SQLite database with FTS5 full-text search, and gives you a Slack-style search experience that actually works.

---

## Features

- **Instant full-text search** — SQLite FTS5 with BM25 ranking and porter stemming
- **ChatGPT + Claude** — both providers in one index, distinguishable by `source`
- **Every Claude surface** — conversations, Claude Design chats, project docs, and memories
- **All branches indexed** — every regenerated response is stored, not just the active path
- **Code-aware** — filter by language, browse code blocks extracted from messages
- **Image & multimodal support** — flags messages containing image/audio attachments
- **Thread context** — expand any result to see surrounding conversation
- **Fully local** — nothing leaves your machine. No API keys, no cloud, no telemetry
- **macOS native** — vibrancy, traffic lights, proper titlebar drag region
- **Fast import** — WAL mode SQLite + batched inserts handle 100k+ messages in seconds

---

## Getting Started

### 1. Export your data

**ChatGPT:** Settings → Data Controls → Export data. You'll receive an email with a `.zip`; inside is `conversations.json`.

**Claude:** Settings → Privacy → Export Data. The `.zip` contains several JSON files — HistoryKit understands all of them (see [Supported Claude exports](#supported-claude-exports)).

### 2. Install and run

```bash
npm install
npm run dev
```

Drop a single JSON file **or an entire export folder** onto the app window. The format is detected automatically — no need to tell it which provider it's from. Import takes a few seconds even for large exports.

### Supported Claude exports

A Claude export bundles multiple surfaces. HistoryKit imports each as first-class, searchable data:

| Surface | Detected as | What's indexed |
|---|---|---|
| Conversations | `claude.conversations` | Messages, code blocks, links, attachments + extracted content |
| Claude Design chats | `claude.design_chat` | Messages plus reconstructed file/tool operations (`write_file`, `str_replace_edit`, …) |
| Project docs | `claude.project` | Each doc as searchable content, stored as a project file |
| Memories | `claude.memory` | Saved memory text |

When you drop a **folder**, HistoryKit first builds an *import manifest* — it classifies every JSON file and reports what it found before writing anything:

```
manifest: { 'claude.conversations': 1, 'claude.design_chat': 22, 'claude.project': 4, 'claude.memory': 1, unknown: 7 }
```

Files are then imported in a deterministic order (conversations → projects → memories → design chats) so individual files merge cleanly on top of the main export. Unrecognized JSON is skipped, not imported.

### Searching Claude data

In the **Messages** search, set **Source** to `Claude` (or `All`) to reveal Claude-aware filters:

- **Claude type** — narrow to conversations, design chats, project docs, or memories
- **Project** — scope results to a single Claude project (populated from imported data)

The search backend (`search:query`) also accepts `hasToolCall` and `filePathContains`, which match messages that produced Claude Design file/tool operations — useful for recovering code context from Claude Design sessions (e.g. *"every message that wrote to `src/components`"*).

### 3. Build for macOS

```bash
npm run build
```

Output is in `release/`. A `.dmg` and `.zip` are produced for distribution.

### 4. Run the tests

```bash
npm test
```

This compiles with `tsc`, then runs the `node --test` suite against the pure
format-detection and Claude-extraction modules using fixtures in
`test/fixtures/` (ChatGPT + every Claude surface, including malformed input).
These modules import no Electron/SQLite, so the suite runs under plain Node.

---

## Architecture

```
historykit/
├── src/
│   ├── main/
│   │   ├── main.ts             # Electron main process, IPC, folder-import manifest
│   │   ├── db.ts               # SQLite init, schema, FTS5 triggers
│   │   ├── parser.ts           # ChatGPT conversations.json tree parser
│   │   ├── parser-claude.ts    # Claude conversation / design-chat parser
│   │   ├── format-detector.ts  # classifyExport() → (source, kind)
│   │   ├── importers/
│   │   │   ├── claude.ts        # Memories + project-docs importers, Claude entry point
│   │   │   ├── claude-extract.ts# Tool-call → file reconstruction
│   │   │   └── shared.ts        # Pure helpers (word count, code blocks, links, paths)
│   │   └── preload.ts          # Secure IPC bridge (contextBridge)
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── App.tsx               # Root, state orchestration
│           ├── components/
│           │   ├── ImportScreen      # Drag & drop landing
│           │   ├── Sidebar           # Nav + conversation list
│           │   ├── SearchBar         # Query input + filters
│           │   ├── StatsBar          # Summary numbers
│           │   ├── ResultsList       # Virtualized result list
│           │   ├── MessageCard       # Expandable result card
│           │   └── DetailPanel       # Thread context + code viewer
│           └── styles/globals.css
└── package.json
```

### Parser design

The `conversations.json` format uses a **tree structure** in `mapping`, not a flat list. Each node has a `parent` pointer. Key decisions:

1. **Tree traversal via parent pointers** — we DFS from root nodes, building children maps first. Never iterate `Object.keys(mapping)` naively as insertion order is not meaningful.

2. **Active branch detection** — trace `current_node` → root to build a `Set<string>` of active node IDs. Every message is stored with `is_active_branch` flag.

3. **All branches indexed** — regenerated responses live on sibling branches. We index all of them so nothing is lost. The `branch_index` column records which sibling a node is.

4. **Content extraction** — handles all known part types:
   - `string` (older format)
   - `content.parts[]` with `string`, `image_asset_pointer`, `audio_asset_pointer`, `tether_quote`, `code` objects
   - Gracefully skips unknown types

5. **FTS5 rebuild** — we bulk-insert via a transaction, then call `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` once. This is ~10x faster than per-row trigger inserts for large imports.

### Database schema

```sql
conversations (id, title, create_time, update_time, current_node,
  source                -- 'chatgpt' | 'claude'
)

messages (
  id, conv_id, parent_id, role, text,
  word_count, has_code, has_image, has_audio,
  code_langs,           -- JSON array of language strings
  create_time, model, finish_reason,
  branch_index,         -- sibling index among parent's children
  is_active_branch,     -- 1 if on the current_node path
  depth,                -- distance from root
  source                -- 'chatgpt' | 'claude'
)

code_blocks (id, message_id, lang, code, position)

-- Provider-specific provenance kept out of the core messages table so common
-- search stays lean. One row per message that carries extra metadata.
message_metadata (
  message_id, provider, kind,   -- kind: conversations | design_chat | project | memory
  model, stop_reason, tool_name,
  project_uuid, project_name, artifact_id,
  workspace_path, imported_from_file, created_at
)

-- Files reconstructed from Claude Design tool calls / project docs
claude_design_files (
  id, conv_id, message_id, project_uuid, project_name,
  file_path, file_name, file_type, operation, source_kind, content, ...
)

messages_fts (FTS5 virtual table, content=messages, porter tokenizer)
```

### Search query

The search IPC handler builds a parameterized SQL query dynamically:
- FTS match via subquery on `messages_fts` rowid
- Filters: `source` (chatgpt/claude), `conv_id`, `role`, `has_code`, `has_image`, `word_count > 300`, `is_active_branch`
- Claude-aware filters (via `EXISTS` so result grain stays one row per message): `claudeKind`, `projectName` (on `message_metadata`), `hasToolCall`, `filePathContains` (on `claude_design_files`)
- Sort: `create_time DESC/ASC` or `word_count DESC`
- Limit: 200 rows (UI shows up to 300 with a note)

---

## Extending

### Add semantic search

Install `sqlite-vec` (replaces `sqlite-vss`). Generate embeddings per message using a local model via `ollama` or `transformers.js`. Store in a `vec_items` virtual table. Add a "Similar messages" button to `DetailPanel`.

```typescript
// In parser.ts, after inserting messages:
const embedding = await generateEmbedding(text) // float32[]
db.prepare(`INSERT INTO vec_items VALUES (?, vec_f32(?))`)
  .run(msgId, new Float32Array(embedding).buffer)
```

### Add keyboard shortcut (global)

In `main.ts`:
```typescript
import { globalShortcut } from 'electron'
app.whenReady().then(() => {
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
})
```

### Re-import detection

Watch the export file for changes using `chokidar`. When the file updates, show a banner offering to re-import.

### Export filtered results

Add a "Export CSV" button to `SearchBar` that calls a new IPC handler writing filtered results to a CSV via `fs.writeFileSync`.

---

## Known limitations

- Images are not stored in `conversations.json` — only flagged as present
- Audio messages are similarly flagged but not playable
- Very large exports (>500MB) may have a slow initial parse; this is a one-time cost
- The FTS5 porter stemmer is English-only; other languages will still work but without stemming

---

## License

MIT
