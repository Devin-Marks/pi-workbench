# Manual End-to-End Test Checklist

The automated scripts under `tests/test-*.ts` cover the HTTP API, the
session registry, and the SSE bridge — but they don't drive the React
UI. This file is the manual checklist for everything that requires a
browser.

When you finish a verification pass, mark the date in the **Last verified**
column. When a phase ships new surface area, add a new section here.

---

## How to run a test pass

1. **Start the dev server:**
   ```bash
   WORKSPACE_PATH="$HOME/Repos" npm run dev
   ```
   (Vite proxies `/api/*` to the Fastify server on `:3000`. Open
   `http://localhost:5173`.)

2. **Configure provider auth** (only needed once per machine; persists
   in `~/.pi/agent/`):
   ```bash
   curl -X PUT http://localhost:5173/api/v1/config/auth/openrouter \
     -H 'Content-Type: application/json' \
     -d '{"apiKey":"sk-or-v1-..."}'

   curl -X PUT http://localhost:5173/api/v1/config/settings \
     -H 'Content-Type: application/json' \
     -d '{"defaultProvider":"openrouter","defaultModel":"minimax/minimax-m2.7"}'
   ```

3. **Verify** at least one model has `hasAuth: true`:
   ```bash
   curl -s http://localhost:5173/api/v1/config/providers | jq \
     '[.providers[] | .models[] | select(.hasAuth)] | length'
   ```
   Should print a non-zero number.

4. **Browser:** open `http://localhost:5173`, work through the
   checklist below, mark each item with the date.

---

## Phase 2 — Authentication

Run with `UI_PASSWORD=hunter2 JWT_SECRET=$(openssl rand -hex 32) npm run dev` to
exercise these. (Default dev session has auth disabled — these will be N/A.)

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| A1 | Login screen shows when `UI_PASSWORD` is set | [ ] | | |
| A2 | Wrong password → "Incorrect password." | [ ] | | |
| A3 | Right password → JWT in localStorage, redirects to shell | [ ] | | |
| A4 | Sign out clears token and shows login screen | [ ] | | |
| A5 | Refresh after sign-in stays signed in (token in localStorage) | [ ] | | |
| A6 | Refresh after sign-out stays signed out | [ ] | | |
| A7 | Protected route via curl with valid `API_KEY` reaches `/api/v1/projects` | [ ] | | |

---

## Phase 3 — Project management

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| P1 | Empty-state forced project picker on first load | [ ] | | |
| P2 | Create a project pointing at an existing folder under `WORKSPACE_PATH` | [ ] | | |
| P3 | Create a project with name / path that already exists → 409 surfaced as friendly error | [ ] | | |
| P4 | Browse picker walks down into subdirectories | [ ] | | |
| P5 | "↑ up" button goes back up; disabled at workspace root | [ ] | | |
| P6 | Folders containing `.git` show "git" badge | [ ] | | |
| P7 | "+ New folder" creates and selects a folder in one go | [ ] | | |
| P8 | Multiple projects show in sidebar, sorted as added | [ ] | | |
| P9 | Switching active project via sidebar click | [ ] | | |
| P10 | Switching active project via topbar dropdown | [ ] | | |
| P11 | Double-click project name in sidebar to rename | [ ] | | |
| P12 | Hover ✕ to delete project (with confirm) | [ ] | | |
| P13 | After delete, on-disk folder is preserved | [ ] | | |
| P14 | Projects survive page refresh (persisted to `projects.json`) | [ ] | | |
| P15 | Projects survive server restart | [ ] | | |
| P16 | Picker rejects path outside `WORKSPACE_PATH` with friendly message | [ ] | | |

---

## Phase 6 / Phase 8 — Sessions + chat

### Session lifecycle

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| S1 | "+ New session" under a project creates one and selects it | [x] | 2026-04-28 | |
| S2 | Multiple sessions per project, click to switch between them | [x] | 2026-04-28 | |
| S3 | Live session shows `●` indicator in sidebar | [ ] | | |
| S4 | Cold session (no `●`) — clicking it auto-resumes from disk via the stream route | [ ] | | |
| S5 | Hover ✕ disposes a live session (with confirm); JSONL preserved | [ ] | | |
| S6 | Disposed sessions appear as cold (no `●`) and can be re-resumed | [ ] | | |
| S7 | Disposing the active session drops the chat view back to the project info page | [ ] | | |
| S8 | Sessions across multiple projects are listed under their respective project rows | [ ] | | |
| S9 | Sidebar collapse state per project persists in localStorage across reload | [ ] | | |

### Chat — happy path

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| C1 | Empty prompt: Send button disabled | [x] | 2026-04-28 | |
| C2 | Submit a short prompt → user message appears immediately (optimistic) | [x] | 2026-04-28 | |
| C3 | "Thinking…" placeholder shows before any text streams in | [x] | 2026-04-28 | |
| C4 | Streaming bubble fills in token-by-token with animated caret | [x] | 2026-04-28 | RAF-coalesced (Pol1 closed) — should now be smooth at fast token rates |
| C5 | After `agent_end`, streaming bubble is replaced by the final assistant message | [x] | 2026-04-28 | Refresh mid-stream also works once stream completes |
| C6 | Long response — auto-scroll keeps the bottom in view | [x] | 2026-04-28 | "Sticky-bottom" behavior (Pol2 closed): only scrolls when user is near bottom, leaves them alone if scrolled up to read earlier output |
| C7 | Subsequent prompt in same session shows new user message + new streaming bubble | [ ] | | |
| C8 | Enter submits, Shift+Enter inserts a newline in the textarea | [ ] | | |

### Chat — tool calls (need a real LLM that can call tools)

These exercise the `ChatView.ToolResult` rendering branches. Prompt the agent to do
each so the corresponding tool fires.

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| T1 | `read` tool: ask "read package.json" — collapsed `<details>` with filename + content | [x] | 2026-04-28 | Was showing "(unknown file)"; fixed to try multiple shape paths and drop label when absent |
| T2 | `bash` tool: ask "run `ls`" — command + stdout in scrollable pre | [x] | 2026-04-28 | Was showing "(unknown command)"; fixed same way |
| T3 | `bash` tool with stderr / non-zero exit — error styling visible | [ ] | | |
| T4 | `edit` tool: ask "rename foo to bar in some-file.ts" — diff renders (raw `<pre>` until Phase 12) | [ ] | | |
| T5 | `write` tool: ask "create a new file" — filename + line count + collapsed content | [ ] | | |
| T6 | Thinking blocks: provider emits thinking content — collapsed `<details>` with "Thinking…" label | [ ] | | |
| T7 | Generic fallback: any unhandled message type renders as collapsed `unknown message` | [ ] | | |

### Chat — control endpoints

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| Ctl1 | While streaming, button label flips to "Queue" + Interrupt + Abort buttons appear | [x] | 2026-04-28 | Renamed from "Steer" — see Ctl2 reasoning |
| Ctl2 | Queue message during streaming is delivered at next agent break | [x] | 2026-04-28 | SDK queues until tool-call boundary or turn end; during plain text it acts like a follow-up. Helper text now explains. |
| Ctl3 | Interrupt button: aborts current run + sends as fresh prompt | [ ] | | |
| Ctl4 | Abort during streaming halts the agent; streaming bubble disappears | [x] | 2026-04-28 | |
| Ctl5 | Abort on idle session resolves cleanly (204) — input re-enables | [ ] | | |

### Chat — error / banner paths

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| E1 | Prompt with no API key configured → banner: "no_api_key — No API key configured for provider …" | [x] | 2026-04-28 | Verified pre-flight check fires |
| E2 | Prompt against a session that's been disposed in another tab → banner: "stream error: session_not_found" | [ ] | | |
| E3 | Server restart during a streaming session → "Reconnecting (attempt N, Ks)…" banner; auto-recovers on next successful connect | [ ] | | streamSSE now has exponential backoff (1→2→4→8→16→30s, capped). Test by killing+restarting server during streaming. |
| E4 | Network drop during streaming (kill server briefly) → reconnect banner; resumes when server returns | [ ] | | Same mechanism as E3. Test by `Ctrl+Z` server, wait, `fg`. |
| E5 | Compaction-triggered context overflow → "Compacting context…" banner appears and clears | [ ] | | Hard to trigger without a long session |
| E6 | Auto-retry on transient error → "Retrying (n/m)…" banner | [ ] | | Hard to reproduce |

---

## Cross-cutting

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| X1 | Refresh browser mid-session → session resumes live, history restored from snapshot | [x] | 2026-04-28 | Verified — full message history reappears once stream completes. |
| X2 | Open the same session in two browser tabs → both see streaming events independently | [ ] | | |
| X3 | Server restart, refresh browser → cold session re-resumes from disk on click | [ ] | | |
| X4 | Switch sessions while one is streaming → SSE closes cleanly, no leaked controllers | [ ] | | |
| X5 | Switch projects while a session is streaming → sidebar updates, chat view stays on the streaming session until you click a different one | [ ] | | |
| X6 | Sign out clears auth + active session; sign back in lands on default project | [ ] | | (auth disabled = N/A) |
| X7 | Active session in localStorage that no longer exists → ChatView falls back to "stream error: session_not_found" banner gracefully | [ ] | | |
| X8 | `/api/docs` (Swagger UI) is reachable from the browser | [ ] | | |

---

## Config (Phase 7 — backend only; UI lands with later phases)

These are curl-only until the SettingsPanel ships.

| # | Test | Status | Last verified | Notes |
|---|------|--------|---------------|-------|
| Cfg1 | `GET /api/v1/config/providers` lists all 25+ built-ins | [x] | 2026-04-28 | |
| Cfg2 | `PUT /api/v1/config/auth/<provider>` adds a key; `GET` shows `configured: true` | [x] | 2026-04-28 | |
| Cfg3 | `GET /api/v1/config/auth` body never contains the actual key value | [x] | 2026-04-28 | Covered by automated test too |
| Cfg4 | `DELETE /api/v1/config/auth/<provider>` removes the key | [ ] | | |
| Cfg5 | `PUT /api/v1/config/settings` partial-merge: `null` deletes, scalar overwrites | [ ] | | |
| Cfg6 | `PUT /api/v1/config/models` adds a custom provider visible in `/providers` listing | [ ] | | |
| Cfg7 | Skills: project-local `.pi/skills/<name>/SKILL.md` discovered, toggleable | [ ] | | |

---

## Deferred polish

Tracked in `notes/DEFERRED.md` (gitignored, contributor-local). The "Last
verified" cells above reference these tags inline:

- **`Pol1`** — streaming bubble jumpy under fast tokens (test C4, C6)
- **`Pol2`** — auto-scroll yanks the user back to bottom (test C6)
- **`Pol3`** — Queue/Interrupt/Abort vs SDK steer semantics (tests Ctl1-Ctl5)
- **`Pol4`** — project delete leaves session JSONLs orphaned (test 11 in cross-cutting)
- **`Pol5`** — no toast when session disposed in another tab (test E2)

When you find a new "works but rough" issue while testing, add the row to
`notes/DEFERRED.md` "Phase 8 polish" first, then reference its tag here.
This file is **what was tested**; `DEFERRED.md` is **what's deferred**.

---

## Not yet implemented (skip these)

These have **no UI path today** — testing them in the browser will get you nowhere.
Move to the relevant column when each phase ships.

| Phase | Feature | Status |
|---|---|---|
| 7 (UI) | Settings panel: providers / agent / skills / model selector tabs | deferred |
| 8 | Markdown rendering for assistant text (currently `<pre>` only) | deferred |
| 8 | Token / cost display from last `agent_end` in chat toolbar | deferred |
| 8 | Session title editable in sidebar (currently first-message preview) | deferred |
| 8 | Auto-reconnect on SSE drop with exponential backoff | DEFERRED.md |
| 9 | Docker / PWA install / offline page | not started |
| 10 | File browser, tabbed CodeMirror editor, autosave | not started |
| 11 | Integrated terminal (xterm.js + node-pty) | not started |
| 12 | Pretty diff rendering for `edit` tool / turn diff panel | not started |
| 13 | Git panel (status, stage, commit, push) | not started |
| 14 | Image / file attachments on prompts | not started |
| 15 | Session tree / fork UI | not started |
| 16 | Context inspector / token usage breakdown | not started |
| 17 | Documentation phase | not started |
| 18 | Polish & release | not started |

---

## How to add a new test

1. Find the relevant section by phase.
2. Append a row to the table with a unique id (P17, S10, etc.).
3. Brief description, blank Status / Last verified columns.
4. When new phases ship UI surface, add a new top-level section.
