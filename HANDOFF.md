# HistoryKit — Coding Agent Handoff

## What is this project?

HistoryKit (LLMContextKit) is an Electron desktop app that imports ChatGPT and Claude conversation exports into a SQLite database for searching and browsing. It includes an MCP server that exposes the indexed data to Claude Code.

## Architecture

```
LLMContextKit/
├── src/main/           ← Electron main process
│   ├── db.ts           ← SQLite schema (tables, FTS5, indexes)
│   ├── parser.ts       ← ChatGPT conversations.json parser
│   ├── parser-claude.ts← Claude data export parser
│   ├── format-detector.ts ← Auto-detect ChatGPT vs Claude format
│   └── main.ts         ← IPC handlers, folder import, window management
├── src/                ← Electron renderer (Vite + React frontend)
├── historykit-mcp/     ← MCP server (separate sub-project)
│   └── src/
│       ├── index.ts    ← MCP server entry point
│       ├── tools.ts    ← 10 MCP tools (search, stats, etc.)
│       ├── importer.ts ← HTTP-based import path (Chrome extension sync)
│       ├── vec.ts      ← sqlite-vec + Ollama embedding helpers
│       └── index_embeddings.ts ← Semantic embedding indexer
```

**Database**: `~/Library/Application Support/historykit/historykit.db` (SQLite with WAL mode)

**Key constraint**: `better-sqlite3` v11.10.0 compiles with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so all FK constraints are enforced. Any DELETE cascade must delete child tables first (embeddings → code_blocks → attachment_contents → attachments → links → memories → messages → conversations).

## Database Schema (from `src/main/db.ts`)

**Core tables:**
- `conversations` — id, title, create_time, update_time, current_node, source ('chatgpt'|'claude')
- `messages` — id, conv_id (FK→conversations), parent_id, role, text, word_count, has_code, has_image, has_audio, code_langs (JSON), create_time, model, source
- `code_blocks` — message_id (FK→messages), lang, code, position

**Restored data tables:**
- `attachments` — message_id, conv_id, type ('image'|'file'), asset_pointer, name, mime_type, width, height, size_bytes
- `links` — message_id, conv_id, url, domain, title
- `memories` — message_id, conv_id, text, create_time

**Search tables:**
- `messages_fts` — FTS5 external content table on messages.text
- `attachment_contents_fts` — FTS5 on attachment extracted content
- `attachment_contents` — message_id, file_name, file_type, file_size, content

**Embedding tables** (created by MCP server only):
- `message_embeddings` — message_id, conversation_id, embedding_model, embedding_dim, role, date, source, text_preview
- `message_vectors_*` — vec0 virtual tables (sqlite-vec, NOT available in Electron app)

## Current MCP Tools (in `historykit-mcp/src/tools.ts`)

1. `search_conversations` — FTS5 full-text search
2. `semantic_search` — Hybrid semantic + FTS with Ollama embeddings
3. `search_code` — Search inside extracted code blocks
4. `get_conversation` — Full conversation thread by ID
5. `get_recent` — Messages from past N days
6. `list_conversations` — Browse conversations by title/date
7. `search_links` — Search extracted URLs by domain/query
8. `list_memories` — Search ChatGPT memory entries
9. `search_attachments` — Search file/image attachments
10. `get_stats` — Summary statistics

## How Memories Work

ChatGPT stores "memories" when the assistant writes to the `bio` tool during conversations. In the export JSON, these are messages where `msg.recipient === 'bio'`. The parser (`src/main/parser.ts`, line 273) detects these and inserts them into the `memories` table with their text content, timestamp, originating message_id, and conv_id.

The `memories` table schema:
```sql
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL,       -- which message created this memory
  conv_id     TEXT NOT NULL,       -- which conversation it came from
  text        TEXT NOT NULL,       -- the memory content
  create_time REAL                 -- unix timestamp
);
CREATE INDEX idx_memories_conv ON memories(conv_id);
CREATE INDEX idx_memories_time ON memories(create_time DESC);
```

Each memory links back to its originating conversation and message via `conv_id` and `message_id`.

---

## Features to Build

There are 5 memory-related features to implement. All changes go in `historykit-mcp/src/tools.ts` (MCP tools) and optionally `src/main/main.ts` (Electron IPC) if the feature should also be available in the desktop UI.

Read all 5 feature descriptions below, then ask the user which one they'd like to build first.

---

### Feature 1: Memory Timeline

**What**: A new MCP tool `memory_timeline` that returns memories in chronological order, grouped by month/week, with the originating conversation title and ID for each memory.

**Why**: Answers "when did ChatGPT learn X about me?" and "what did it pick up from that conversation?"

**Implementation steps**:

1. Add a new tool definition to the `toolDefinitions` array in `historykit-mcp/src/tools.ts`:
   - Name: `memory_timeline`
   - Input: `{ group_by?: 'month' | 'week' | 'day', limit?: number }`
   - Description: "Chronological timeline of ChatGPT memories showing when each was created and which conversation it came from"

2. Add a new function `memoryTimeline(args, db)`:
   - Guard with `tableExists(db, 'memories')`
   - Query memories joined with conversations, ordered by `create_time ASC`
   - Group results by the chosen time period using SQLite `strftime`:
     - month: `strftime('%Y-%m', create_time, 'unixepoch')`
     - week: `strftime('%Y-W%W', create_time, 'unixepoch')`
     - day: `strftime('%Y-%m-%d', create_time, 'unixepoch')`
   - Return structure: `{ groups: [{ period: "2024-03", memories: [{ text, date, conv_id, conv_title }] }] }`

3. Add the case to `executeTool()` switch statement

---

### Feature 2: Memory-Aware Search Boosting

**What**: Enhance the existing `search_conversations` tool to optionally boost results that relate to stored memories.

**Why**: Makes every search smarter by leveraging what ChatGPT already knows about the user. This compounds — more memories = more relevant results.

**Implementation steps**:

1. Add an optional `boost_with_memories` boolean parameter to the `search_conversations` tool definition in `toolDefinitions`

2. Modify `searchConversations()` in `historykit-mcp/src/tools.ts`:
   - When `boost_with_memories` is true and the `memories` table exists:
     - Load all memory texts: `SELECT text FROM memories`
     - Build a set of significant keywords from memories (split on whitespace, filter stopwords, take words 4+ chars)
     - After getting FTS results, compute a memory relevance score for each result by counting how many memory keywords appear in the result's snippet/text
     - Re-sort results by a combined score: `original_rank_score + (memory_keyword_matches * boost_weight)`
   - Include a `memory_boost_applied: true` field in the response so the agent knows boosting was used

3. Alternatively, a simpler approach — expand the FTS query itself:
   - Extract key terms from memories that match the query topic
   - Append them to the FTS query as optional terms using OR
   - This lets SQLite's BM25 handle the ranking naturally

The simpler approach (option 3) is recommended — it keeps ranking in SQLite's BM25 where it belongs and avoids custom scoring logic.

---

### Feature 3: Memory Conflict Detection

**What**: A new MCP tool `memory_conflicts` that finds memories that may contradict each other or are near-duplicates.

**Why**: ChatGPT accumulates memories over time without cleanup. Contradictions ("user prefers Python" + "user prefers TypeScript") lead to inconsistent behavior.

**Implementation steps**:

1. Add a new tool definition to `toolDefinitions`:
   - Name: `memory_conflicts`
   - Input: `{ similarity_threshold?: number }` (default 0.7)
   - Description: "Find memories that may contradict or duplicate each other"

2. Add a new function `memoryConflicts(args, db)`:
   - Load all memories: `SELECT id, text, create_time, conv_id FROM memories ORDER BY create_time`
   - **Duplicate detection**: Compare every pair of memories using word overlap (Jaccard similarity on word sets). Flag pairs above the threshold as potential duplicates.
   - **Conflict detection**: Look for pattern-based contradictions:
     - Extract "user prefers/uses/likes X" patterns
     - Extract "user is a/works as X" patterns
     - Flag memories that share the same pattern prefix but differ in the value
   - Return: `{ duplicates: [{ memory_a, memory_b, similarity }], conflicts: [{ memory_a, memory_b, reason }] }`

3. Add the case to `executeTool()` switch statement

4. For a more robust approach later, if semantic embeddings are available, use cosine similarity on memory embeddings (via the existing `message_embeddings` table) instead of Jaccard. But Jaccard on word sets is a solid v1.

---

### Feature 4: Conversation-to-Memory Enrichment

**What**: Enhance the existing `get_conversation` tool to annotate the response with any memories that were created during that conversation.

**Why**: Gives context about what ChatGPT "took away" from a conversation — useful for understanding why ChatGPT behaves a certain way.

**Implementation steps**:

1. In `getConversation()` in `historykit-mcp/src/tools.ts` (around line 608):
   - After fetching links and attachments, also query memories for the conversation:
     ```sql
     SELECT text, create_time, message_id
     FROM memories
     WHERE conv_id = ?
     ORDER BY create_time ASC
     ```
   - Guard with `tableExists(db, 'memories')`

2. Add the memories to the response object:
   ```typescript
   if (memories.length > 0) {
     result.memories_created = memories.map(m => ({
       text: m.text,
       date: fmtTime(m.create_time),
       after_message: m.message_id,  // which message triggered this memory
     }))
   }
   ```

3. This is a small change — just ~10 lines of code added to an existing function. No new tool needed.

---

### Feature 5: Memory Export

**What**: A new MCP tool `export_memories` that dumps all memories as a flat, portable list.

**Why**: Lets users review everything ChatGPT thinks it knows about them, port their "profile" to another AI system, or back up their memories before clearing them.

**Implementation steps**:

1. Add a new tool definition to `toolDefinitions`:
   - Name: `export_memories`
   - Input: `{ format?: 'list' | 'markdown' | 'json', include_source?: boolean }`
   - Description: "Export all ChatGPT memories as a portable list for review, backup, or transfer to another AI"

2. Add a new function `exportMemories(args, db)`:
   - Guard with `tableExists(db, 'memories')`
   - Query all memories with conversation context:
     ```sql
     SELECT mem.text, mem.create_time, c.title as conv_title, mem.conv_id
     FROM memories mem
     JOIN conversations c ON c.id = mem.conv_id
     ORDER BY mem.create_time ASC
     ```
   - Format based on the `format` parameter:
     - `list` (default): Return as a JSON array of `{ text, date }`
     - `markdown`: Return as a markdown bullet list with dates
     - `json`: Return full data including conv_id and conv_title
   - If `include_source` is true, include `conv_id` and `conv_title` in all formats

3. Add the case to `executeTool()` switch statement

---

## Build & Test Commands

```bash
# Main Electron app (from project root)
npx tsc                     # Type-check
npm run dev                 # Dev server (Vite + Electron)

# MCP server (from project root)
npm run mcp:build           # Build MCP server

# Or from MCP directory
cd historykit-mcp && npx tsc
```

## Important Gotchas

- **FK enforcement is always ON** — `better-sqlite3` compiles with `SQLITE_DEFAULT_FOREIGN_KEYS=1`. Any new tables with FKs need corresponding delete cascades in both parsers.
- **`sqlite-vec` is MCP-only** — The vec0 extension is loaded only in the MCP server (`historykit-mcp/src/vec.ts`), not in the Electron app. Never reference `message_vectors` from Electron code.
- **`tableExists()` guards** — Always check if a table exists before querying it. The `memories`, `links`, and `attachments` tables may not exist in older databases. See the existing pattern in `tools.ts`.
- **FTS query safety** — Use the `ftsQuery()` helper to escape user input before passing to FTS5 MATCH.

---

## Feature 6: Frontend Redesign

The current frontend is functional but oriented around raw message search results. It needs to be redesigned so a human can intuitively access the same capabilities the MCP tools provide, without needing a coding agent.

### Current Frontend State

The renderer lives in `src/renderer/src/` and uses React + CSS Modules + Vite.

**Current components:**
- `App.tsx` — Root component. Two modes: `search` and `mcp`. Manages all state (query, filters, results, selected message).
- `Sidebar.tsx` — Left sidebar with browse filters (All, Code, Images, Long replies, Branches), a scrollable conversation list, MCP button, and Re-import button.
- `SearchBar.tsx` — Top bar with text search input, sort dropdown, source filter (ChatGPT/Claude), branch toggle.
- `ResultsList.tsx` — Flat list of `MessageCard` components. Caps at 300 rendered.
- `MessageCard.tsx` — Individual message result. Shows role avatar, source badge, model, date, conversation title, code blocks with copy, expand/collapse. Has query term highlighting.
- `DetailPanel.tsx` — Right slide-out panel when a message is selected. Two tabs: "Thread context" (full conversation thread) and "Code" (extracted code blocks with copy). Shows message metadata.
- `StatsBar.tsx` — Horizontal stats strip: messages, conversations, code blocks, images, words indexed. Shows per-source breakdown.
- `McpPanel.tsx` — MCP setup screen with status pills, config JSON, install button.
- `ImportScreen.tsx` — Initial landing screen with drag-and-drop zone for JSON import.

**Current preload API** (`src/main/preload.ts`):
The renderer can call: `openFile`, `importFile`, `search`, `stats`, `conversations`, `messageContext`, `codeBlocks`, `clearDB`, `mcpStatus`, `installClaudeMcp`, `showMcpConfig`.

**IPC handlers already exist in `main.ts` but are NOT exposed through preload:**
- `dialog:openFileForMerge` / `import:merge` — merge import flow
- `search:codeblocks` / `search:codeLangs` — dedicated code block search
- `attachments:list` — list attachments by type
- `links:list` — list all extracted links
- `memories:list` — list all memories
- `shell:openExternal` — open URLs in browser

### Redesign Goal

Replace the current single-purpose search view with a multi-view layout that mirrors the MCP tool capabilities. The app should feel like a personal knowledge base, not just a search box.

### New View Structure

Restructure the sidebar navigation from filter toggles to distinct views. Replace the current `ViewFilter` type (`'all' | 'code' | 'images' | 'long' | 'user' | 'assistant' | 'branches'`) with a proper view-based navigation.

**View 1: Search (default)**
- Unified search that combines message text, code blocks, and attachment content
- Keep the current `SearchBar` + `ResultsList` + `DetailPanel` layout
- Add search scope tabs above results: "Messages" | "Code" | "Files" — these switch between the existing `search:query`, `search:codeblocks`, and a new attachment content search
- Keep existing filters (source, sort, branch toggle) but move them into a collapsible filter row
- Add a "Links" result type that searches the links table

**View 2: Browse**
- Timeline-based conversation browser (replaces the sidebar conversation list as the primary browse experience)
- Group conversations by month, showing title, message count, source badge, and content type indicators (has code, has images, has files)
- Clicking a conversation opens the thread in the detail panel (reuse existing `DetailPanel` thread view)
- Add date range picker for filtering
- Add source filter (ChatGPT/Claude/All)

**View 3: Profile**
- "What ChatGPT knows about me" dashboard
- Three sections:
  - **Memories**: Chronological list of all memory entries, each linking to its originating conversation. Use the existing `memories:list` IPC handler.
  - **Links**: Grouped by domain, showing most-referenced sites. Use the existing `links:list` IPC handler. Clicking a link opens it externally via `shell:openExternal`.
  - **Attachments**: Grid/list of uploaded files and images, filterable by type. Use the existing `attachments:list` IPC handler.
- Each section should have a count badge in the section header

**View 4: MCP Setup**
- Keep the existing `McpPanel` component largely as-is
- It already works well for its purpose

### Implementation Steps

#### Step 1: Expose missing IPC handlers through preload

Update `src/main/preload.ts` to expose the IPC handlers that already exist in `main.ts` but aren't accessible from the renderer:

```typescript
// Add to the existing contextBridge.exposeInMainWorld('api', { ... })
openFileForMerge: () => ipcRenderer.invoke('dialog:openFileForMerge'),
mergeImport: (paths: string[]) => ipcRenderer.invoke('import:merge', paths),
searchCodeBlocks: (params: any) => ipcRenderer.invoke('search:codeblocks', params),
codeLangs: () => ipcRenderer.invoke('search:codeLangs'),
listAttachments: (type: string) => ipcRenderer.invoke('attachments:list', type),
listLinks: () => ipcRenderer.invoke('links:list'),
listMemories: () => ipcRenderer.invoke('memories:list'),
openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
```

Update `src/renderer/src/global.d.ts` with matching type declarations.

#### Step 2: Refactor App.tsx view routing

Replace the current `AppMode = 'search' | 'mcp'` with:

```typescript
type AppView = 'search' | 'browse' | 'profile' | 'mcp'
```

Update `App.tsx` to render the correct view component based on `activeView`. The sidebar's browse section should switch to navigation buttons for each view instead of filter toggles.

#### Step 3: Refactor Sidebar.tsx

Replace the current filter-based navigation with view-based navigation:

```
SIDEBAR LAYOUT:
┌─────────────────────┐
│ HistoryKit          │
├─────────────────────┤
│ ▸ Search            │  ← default view
│ ▸ Browse            │  ← timeline conversation browser
│ ▸ Profile           │  ← memories/links/attachments
│ ▸ MCP Setup         │  ← existing MCP panel
├─────────────────────┤
│ Stats summary       │  ← compact stats (conversations, messages)
├─────────────────────┤
│ [Import] [Merge]    │  ← import actions
└─────────────────────┘
```

Remove the conversation list from the sidebar — it moves into the Browse view as a first-class experience with proper grouping and filtering.

#### Step 4: Build the Browse view

New component: `src/renderer/src/components/BrowseView.tsx`

- Fetch conversations from `window.api.conversations()`
- Group by month using `update_time`
- Render as a timeline with month headers and conversation cards
- Each card shows: title, message count, date, source badge, content indicators
- Clicking a card loads the conversation thread (reuse existing `messageContext` API)
- Add a search-within-browse filter for title text
- Add date range and source filters

#### Step 5: Build the Profile view

New component: `src/renderer/src/components/ProfileView.tsx`

Three sub-sections, each as a collapsible panel or tab:

**Memories section:**
- Call `window.api.listMemories()`
- Render as a timeline list with date and originating conversation title
- Clicking a memory navigates to its conversation in Browse view

**Links section:**
- Call `window.api.listLinks()`
- Group by domain, sort by frequency
- Show domain, count, most recent URL
- Click to open in browser via `window.api.openExternal(url)`

**Attachments section:**
- Call `window.api.listAttachments('image')` and `window.api.listAttachments('file')`
- Toggle between images and files
- Show file name, type, size, date, conversation title
- Clicking navigates to the conversation

#### Step 6: Enhance SearchBar with scope tabs

Add tabs to the search view: "Messages" | "Code" | "Files"

- **Messages**: Current behavior (FTS5 search via `search:query`)
- **Code**: Uses `window.api.searchCodeBlocks()` — show code blocks with language badges and conversation context. Add a language filter dropdown populated by `window.api.codeLangs()`.
- **Files**: Search `attachment_contents` via the existing FTS query in `search:query` (it already searches `attachment_contents_fts`)

#### Step 7: Update StatsBar

The `Stats` interface in `App.tsx` already has `withFiles`, `withLinks`, `withMemories` fields from the IPC handler. Update `StatsBar.tsx` to display them:

- Add: Links count, Files count, Memories count
- Consider making stats clickable — clicking "Links" navigates to Profile > Links section

### Design Notes

- Keep the existing dark theme (`backgroundColor: '#0d0d0f'`)
- Use the existing CSS Modules pattern — one `.module.css` per component
- Keep the `hiddenInset` titlebar style with traffic light positioning
- The existing `MessageCard` and `DetailPanel` components should be reused across views, not duplicated
- The existing SVG icon style (inline, stroke-based, 13-15px) should be maintained for new nav items
- All new views should support the existing drag-and-drop re-import behavior (the `onDrop` handler on the root div)

### Files to Create
- `src/renderer/src/components/BrowseView.tsx` + `.module.css`
- `src/renderer/src/components/ProfileView.tsx` + `.module.css`

### Files to Modify
- `src/main/preload.ts` — expose missing IPC handlers
- `src/renderer/src/global.d.ts` — add type declarations for new API methods
- `src/renderer/src/App.tsx` — new view routing, updated types
- `src/renderer/src/components/Sidebar.tsx` + `.module.css` — view-based navigation
- `src/renderer/src/components/SearchBar.tsx` + `.module.css` — add scope tabs
- `src/renderer/src/components/StatsBar.tsx` + `.module.css` — show links/files/memories counts

---

## Final Instructions for the Coding Agent

After reading this document and the source files it references, ask the user:

**"I've reviewed the HistoryKit codebase and the handoff document. There are 5 memory-related MCP features and a frontend redesign to implement. Which would you like me to build first?"**

Then list all 6 briefly:
1. Memory Timeline — chronological view of when ChatGPT learned things about you
2. Memory-Aware Search Boosting — make search results smarter using stored memories
3. Memory Conflict Detection — find contradictory or duplicate memories
4. Conversation-to-Memory Enrichment — show what memories were created during a conversation
5. Memory Export — dump all memories as a portable list
6. Frontend Redesign — restructure the UI into Search, Browse, Profile, and MCP views
