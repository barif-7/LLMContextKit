# HistoryKit

> Local ChatGPT conversation search. Fast, private, offline.

ChatGPT's built-in search is slow and misses most of what you've written. HistoryKit imports your `conversations.json` export, indexes everything into a local SQLite database with FTS5 full-text search, and gives you a Slack-style search experience that actually works.

---

## Features

- **Instant full-text search** — SQLite FTS5 with BM25 ranking and porter stemming
- **All branches indexed** — every regenerated response is stored, not just the active path
- **Code-aware** — filter by language, browse code blocks extracted from messages
- **Image & multimodal support** — flags messages containing image/audio attachments
- **Thread context** — expand any result to see surrounding conversation
- **Fully local** — nothing leaves your machine. No API keys, no cloud, no telemetry
- **macOS native** — vibrancy, traffic lights, proper titlebar drag region
- **Fast import** — WAL mode SQLite + batched inserts handle 100k+ messages in seconds

---

## Getting Started

### 1. Export your ChatGPT data

In ChatGPT: **Settings → Data Controls → Export data**

You'll receive an email with a `.zip`. Inside is `conversations.json`.

### 2. Install and run

```bash
npm install
npm run dev
```

Drop your `conversations.json` onto the app window. Import takes a few seconds even for large exports.

### 3. Build for macOS

```bash
npm run build
```

Output is in `release/`. A `.dmg` and `.zip` are produced for distribution.

---

## Architecture

```
historykit/
├── src/
│   ├── main/
│   │   ├── main.ts       # Electron main process, IPC handlers
│   │   ├── db.ts         # SQLite init, schema, FTS5 triggers
│   │   ├── parser.ts     # conversations.json tree parser
│   │   └── preload.ts    # Secure IPC bridge (contextBridge)
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
conversations (id, title, create_time, update_time, current_node)

messages (
  id, conv_id, parent_id, role, text,
  word_count, has_code, has_image, has_audio,
  code_langs,           -- JSON array of language strings
  create_time, model, finish_reason,
  branch_index,         -- sibling index among parent's children
  is_active_branch,     -- 1 if on the current_node path
  depth                 -- distance from root
)

code_blocks (id, message_id, lang, code, position)

messages_fts (FTS5 virtual table, content=messages, porter tokenizer)
```

### Search query

The search IPC handler builds a parameterized SQL query dynamically:
- FTS match via subquery on `messages_fts` rowid
- Filters: `conv_id`, `role`, `has_code`, `has_image`, `word_count > 300`, `is_active_branch`
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
