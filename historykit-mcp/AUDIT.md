# HistoryKit production-readiness audit

Scope: single-user, local-first, always-on personal service (Mac mini Tailscale hub).
"Production-ready" = doesn't crash, doesn't corrupt `historykit.db`, fails gracefully when
Ollama is down, secured appropriately for a private tailnet. Multi-tenant/public-SaaS
hardening is explicitly out of scope.

Audited: `historykit-mcp/src/*` (index, tools, importer, http_server, vec, migrate,
index_embeddings, dbPath, promptArtifacts), `src/main/*` (db, parser, parser-claude, main,
sync, search, format-detector), tests, git state. All findings verified against source.

Severity counts: **P0: 3 · P1: 5 · P2: 8 · P3: 6**

---

## P0 — data loss, corruption, or silent wrong results

### P0-1. Full-database wipe runs OUTSIDE the import transaction
`src/main/parser.ts:82-84` — a non-merge ChatGPT import first commits
`DELETE FROM … messages; DELETE FROM conversations;` (everything, including
`message_embeddings`), **then** runs the insert transaction (`importAll()`, line 290).
If the import throws mid-way — and it can: `mapping[nodeId].parent` at
`parser.ts:124/132` raises `TypeError` on a single null mapping node — the deletes are
already committed and the inserts roll back. **Result: entire history lost** (recoverable
only by re-import, and embeddings by a 9-minute re-backfill).
**Fix:** move the wipe inside the `importAll` transaction (and guard null mapping nodes).

### P0-2. `message_vectors` is never cleaned up → silent semantic degradation, then a crashed backfill
Every path that deletes embedding *metadata* leaves the sqlite-vec rows behind:
- `src/main/parser.ts:83` (full wipe) and `:90` (merge)
- `src/main/main.ts:834` (`db:clear`)
- `historykit-mcp/src/importer.ts:386-389,460` (HTTP `/import` conversation update)
- `src/main/parser-claude.ts:76-79,129`

(The Electron process can't `DELETE FROM message_vectors` because it never loads the
sqlite-vec extension — any statement touching a vec0 table without the module errors.)
Consequences, in order of appearance:
1. After any conversation re-import, orphaned vectors occupy KNN slots in
   `vectorSearchRows` (`tools.ts:887-896`); the JOIN against `message_embeddings`
   silently drops them, so `semantic_search` returns **fewer results than k with no
   indication** — silent wrong results.
2. The next `npm run semantic:update` (non-reset) **crashes**: `index_embeddings.ts:131-134`
   does a plain `INSERT INTO message_vectors`, which hits the vec0 PRIMARY KEY of the
   orphaned row, throws inside `commitChunk`, and aborts the whole run.
**Fix (minimal, MCP-side only):** at the start of `index_embeddings.ts`, purge orphans
(`DELETE FROM <vectorTable> WHERE message_id NOT IN (SELECT message_id FROM
message_embeddings)`) and make the vector insert `INSERT OR REPLACE`. Orphans then exist
only transiently between a re-import and the next index run, and can never break it.

### P0-3. Import error handling in the Electron parser amplifies P0-1
`src/main/parser.ts:102-290` — `importAll` is one transaction for ALL conversations; a
single malformed conversation (null node, bad shape) aborts the entire import with no
per-conversation error isolation (the MCP importer does this correctly with a
per-conversation transaction + errors array, `importer.ts:686-696`). Combined with P0-1
this turns "one bad conversation in the export" into "empty database".
**Fix:** per-conversation try/catch (mirror `importer.ts`), collect errors, continue.

---

## P1 — reliability gaps that will bite during normal always-on use

### P1-1. No cycle guard in the mapping-tree walk → infinite loop hangs the daemon
A malformed/truncated ChatGPT export with a parent-pointer cycle (`A.parent=B, B.parent=A`):
- active-path trace: `src/main/parser.ts:138-141,147-150` and
  `historykit-mcp/src/importer.ts:493-496,501-504` — `while (cursor && mapping[cursor])`
  never exits.
- DFS: `parser.ts:171-284` / `importer.ts:528-679` — no visited set; cyclic `children`
  edges grow the stack forever.
In `http_server.ts` the import runs synchronously on the request handler, so this hangs
the whole HTTP daemon (and `/health`). **Fix:** visited-set in both loops (3 files).

### P1-2. `ollamaEmbed` has no timeout → semantic_search and backfill can hang forever
`historykit-mcp/src/vec.ts:61-66` — plain `fetch` with no `AbortSignal`. If Ollama is
wedged (not down — hung), every `semantic_search` MCP call blocks indefinitely and the
backfill stalls without error. **Fix:** `signal: AbortSignal.timeout(…)` (~30s) with a
clear error message.

### P1-3. semantic_search hard-fails when Ollama is down instead of degrading
`historykit-mcp/src/tools.ts:798` — `await ollamaEmbed(query)` throws (`fetch failed`),
caught generically at `index.ts:61-66`, so the agent gets `{"error":"fetch failed"}` and
no results — even though the FTS leg (`ftsSearchRows`, already computed at line 797) has
answers. **Fix:** catch the embed failure, return FTS-only results with
`semantic_degraded: true` + a next_step explaining Ollama is unreachable.

### P1-4. FTS index is dropped and rebuilt on every app launch, non-atomically
`src/main/db.ts:128-131` unconditionally `DROP TABLE messages_fts` then recreates +
full `rebuild` (line 183) on every startup. `db.exec` autocommits per statement, so a
crash between DROP and rebuild leaves the DB with **no FTS table** — every MCP
`search_conversations` then throws until the app is launched again. Also O(corpus)
startup cost that grows forever. **Fix:** drop only when the FTS schema actually needs
to change (guard on a schema marker), otherwise `CREATE IF NOT EXISTS` only.

### P1-5. UI search passes raw user input to FTS5 MATCH → query syntax errors throw
`src/main/main.ts:497-498` (`params.query + '*'`) and `src/main/search.ts:61-65`
(`toMatchQuery`) do not strip FTS5 operators. A query containing `"`...`(`...`)` raises
`SqliteError: fts5: syntax error`, rejecting the IPC call and breaking renderer search.
The MCP side already solves this (`tools.ts:44-50 ftsQuery`). **Fix:** apply the same
sanitization in both IPC handlers.

---

## P2 — context-appropriate security, correctness edge cases, resources

### P2-1. HTTP transport has no auth token
`historykit-mcp/src/http_server.ts:12-13` binds `127.0.0.1:8765` (good) with origin
checks for browsers, but any local process can POST `/import` (writes to the DB).
Acceptable while loopback-only; **must** gain a bearer token before binding to the
Tailscale interface. No secrets found committed anywhere (grep clean); `.gitignore`
covers `*.db`.

### P2-2. `write_prompt_timeline_report` writes to any caller-supplied path
`historykit-mcp/src/promptArtifacts.ts:362-367` — `output_path` from MCP tool args is
used verbatim (`fs.writeFileSync`); a prompt-injected agent could overwrite any
user-writable file. **Fix:** restrict to a fixed reports directory, reject `..`/absolute
escapes. *(Note: this file is uncommitted owner work-in-progress.)*

### P2-3. `list_prompt_artifacts` throws on DBs without `claude_design_files`
`promptArtifacts.ts:231-241` — prepared without a `tableExists` guard (all sibling tools
guard; cf. `tools.ts:1178,1234,1276`). One missing table breaks the whole tool. *(Also
uncommitted WIP.)*

### P2-4. Full FTS rebuild per import call
`importer.ts:698-701` — `messages_fts('rebuild')` scans the entire messages table on
**every** `/import` POST; the direct-sync script posts in batches of 25 conversations
(`http_server.ts directSyncScript POST_BATCH_SIZE=25`), so a 600-conversation sync
triggers ~24 full rebuilds. Triggers (`importer.ts:277-288`) already keep FTS in sync;
the rebuild is a redundancy that gets slower as the corpus grows. **Fix:** rebuild only
on demand / integrity failure, or once per sync, not per batch.

### P2-5. Readonly MCP connection sets `journal_mode = WAL`
`historykit-mcp/src/index.ts:39` — a no-op while the DB is already WAL, but if it ever
isn't, setting a journal mode on a readonly connection throws at boot → fatal exit.
**Fix:** wrap in try/catch or query instead of set.

### P2-6. `merge` import builds `IN (…)` with one placeholder per conversation
`src/main/parser.ts:88-98` — >32,766 conversations in one merge exceeds SQLite's bound
parameter limit and throws. Unlikely at current scale; chunk the deletes.

### P2-7. Duplicate message ids within one conversation create duplicate child rows
`importer.ts:573-599` — `INSERT OR REPLACE INTO messages` tolerates a message id
appearing twice in a mapping, but `code_blocks`/`links`/`attachments` are plain INSERTs →
duplicated rows for that message. Low frequency; dedupe msgId per conversation walk.

### P2-8. `getDbStatus.embedded_count` ignores model/dim
`importer.ts:322-325` counts all `message_embeddings` rows; `get_stats`
(`tools.ts:1528-1533`) filters by configured model+dim. After a model swap the two
disagree. Align `getDbStatus` with the filtered count.

---

## P3 — maintainability / cleanup

- **P3-1** `promptArtifacts.ts:22` hard-codes `/Users/basilarif/Downloads` as report dir.
- **P3-2** `main.ts:531,651,784,819` interpolate `LIMIT ${limit}` from renderer params —
  parameterize for hygiene (IPC is same-app, low risk).
- **P3-3** `tools.ts:1404-1442` `memory_conflicts` is O(n²) over memories — fine at
  current counts, will crawl past ~5k memories.
- **P3-4** Daemon logs (`http_server.ts`, `index.ts`) lack timestamps — prepend ISO
  timestamps for debuggability of an always-on service.
- **P3-5** Schema is not versioned (`PRAGMA user_version` unused). Current migrations are
  idempotent (`CREATE IF NOT EXISTS` + column probes, `migrate.ts:38-43`,
  `db.ts:188-193`), so old-DB/new-code is currently safe — but ordering will become
  ambiguous as migrations accumulate.
- **P3-6** `INSERT OR REPLACE INTO messages` would bypass the FTS delete trigger
  (SQLite fires delete triggers under REPLACE only with `recursive_triggers=ON`). Today
  every path explicitly deletes rows first, and rebuilds run after imports, so it's
  mitigated — leave a comment or switch to explicit upserts so this stays true.

---

## What's already solid (verified, no action)

- All SQL is parameterized; the one dynamic identifier goes through `quoteIdentifier`
  (`vec.ts:42-47`); `strftime` format strings come from a fixed whitelist
  (`tools.ts:1342-1344`).
- Vector table dimension is config-derived; per-model table naming
  (`message_vectors_<model>_<dims>`, `vec.ts:31-39`) makes dimension collisions
  structurally impossible; `index_embeddings` refuses to run over a mismatched index
  (`index_embeddings.ts:96-109`).
- The embedding backfill is resumable and batch-committed (50/txn); embed failures retry
  with truncation + backoff.
- MCP stdio server opens the DB readonly + `query_only`; one tool error returns
  `isError` without killing the server (`index.ts:56-67`).
- WAL mode + per-conversation transactions on the HTTP import path; DB closed on
  SIGINT/SIGTERM in all entry points.
- `[not in index]` honesty rule holds: every context-pack bucket renders the marker when
  empty (`tools.ts:597-618`), Open Loops is hard-coded honest.
- No secrets in the repo; `.gitignore` covers DB artifacts.

---

## Recommended bounded fix plan (Phase 2 proposal)

**Do now — P0 + P1, five small category-grouped commits:**
1. **Import crash-safety (P0-1, P0-3 + null-node guard):** wipe inside transaction,
   per-conversation error isolation in `parser.ts`.
2. **Vector lifecycle (P0-2):** orphan purge + `INSERT OR REPLACE` in
   `index_embeddings.ts` (MCP-side only; no Electron changes needed).
3. **Parser cycle guards (P1-1):** visited sets in `parser.ts`, `importer.ts`
   (+ `parser-claude.ts` is linear, no tree — no change).
4. **Ollama failure modes (P1-2, P1-3):** fetch timeout in `vec.ts`; FTS-only graceful
   degradation in `semantic_search`.
5. **FTS robustness (P1-4, P1-5):** conditional FTS drop in `db.ts`; sanitize MATCH input
   in `main.ts`/`search.ts`.

Plus targeted tests: malformed-export fixtures (cycle, null node, mid-import failure),
Ollama-down degradation, orphan-purge round-trip. Regression gate: `eval_retrieval.mjs`
diff + `get_stats` before/after.

**Defer:** all P2 (HTTP auth lands when the port moves onto the tailnet; P2-2/P2-3 sit in
uncommitted owner WIP), all P3.

**Working-tree note:** `historykit-mcp/src/tools.ts` (+76 lines), `src/projects.json`,
and untracked `src/promptArtifacts.ts` are the owner's uncommitted prompt-artifacts
feature; Phase 2 commits will stage only audit-fix files and leave that work untouched.
