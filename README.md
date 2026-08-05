# Fury IDE

A prototype IDE for AI-assisted development built with Next.js and the Claude Agent SDK. Fury IDE provides a web-based interface for interacting with Claude, managing chat sessions, building visual workflows, and organizing project notes.

## Features

### Chat Interface
- **SDK-backed sessions** - Sessions run on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`): one persistent, warm streaming query per session, with mid-session model switching, native rewind, and background-task activity. A legacy Claude CLI path remains behind the `sdkSessionsEnabled` setting (on by default)
- **Unified session list** - Browse all sessions from `~/.claude/history.jsonl` with live session indicators
- **Streaming responses** - Real-time streamed output over SSE with tool use activity indicators
- **Markdown rendering** - Assistant responses rendered with syntax highlighting (via `react-markdown`, `remark-gfm`, `rehype-highlight`)
- **Rich text input** - TipTap-based editor with code block support (Enter to send, Shift+Enter for newline)
- **Stop/Kill controls** - Abort an in-flight turn or kill a stuck session's warm process
- **AskUserQuestion support** - Interactive dialog when Claude requests user input via the AskUserQuestion tool
- **Prompt suggestions** - Detects stale/idle sessions with incomplete responses and suggests follow-up prompts (configurable)
- **Long conversation warnings** - Visual indicator when sessions exceed 50 messages
- **Compaction detection** - Hides context compaction messages from the transcript with visual indicator

### Canvas (Workflow Builder)
- **Drawflow-based visual canvas** - Drag-and-drop node editor for building workflows
- **Node types** - Rectangle, Diamond, and Circle nodes with configurable inputs/outputs
- **Per-node chat** - Double-click any node to open a chat session scoped to that node
- **Workflow persistence** - Create, rename, delete, and auto-save workflows to disk
- **Import/Export** - Workflows stored as JSON in `.claude-workflows/`

### Right Panel
- **Stream** - Live stream of tool use events, text output, and errors during Claude responses
- **File Tree** - Explore the active session's project directory (filters out `node_modules`, `.next`, `.git`, etc.)
- **Notes** - Per-project rich text notes with auto-save (stored in `~/.claude-session-notes/`)
- **MCP Servers** - Manage Model Context Protocol servers with a guided wizard

### Settings
- **Allow external connections** - Toggle to permit or block access from non-localhost IPs
- **Prompt suggestions** - Toggle to enable/disable follow-up prompt suggestions for stale sessions

### General
- **Light/Dark theme** - Toggle via toolbar button, persisted in localStorage
- **Directory picker** - Browse filesystem to select project directories for new sessions
- **Resizable panels** - All panels are drag-resizable via `react-resizable-panels`
- **UI state persistence** - Active tab and workflow selection restored across page reloads

## Voice Input & TTS Playback (Optional)

Fury supports voice dictation for prompts and text-to-speech playback of Claude's responses. Both are off by default.

### Dictation

Microphone button in the chat editor uses the browser's Web Speech API. Spoken
punctuation ("period", "comma", "question mark", "new paragraph", etc.) is
converted inline. Say **"send"** to submit (5-second delay allows corrections).
Recording auto-stops after 30 seconds of silence.

- **Browsers:** Chrome or Edge (Firefox does not implement Web Speech)
- **Locale:** hardcoded to `en-US`
- **Privacy note:** Chrome/Edge route audio through their cloud speech service —
  no local STT server is involved

### TTS Playback

Toggle in Settings. The pipeline cleans markdown out of the response, optionally
summarizes it, then synthesizes audio with Kokoro-82M.

**Synthesizer (`ttsProvider` in settings):**

| Mode | Setup |
|------|-------|
| `local` | None — bundled `kokoro-js` runs Kokoro-82M in the Node process |
| `remote` | Set `ttsRemoteHost` / `ttsRemotePort` to a server exposing `POST /kokoro/tts` (body `{ text }`, returns WAV) |

Voice is `af_heart` (American female). Kokoro-82M v1.0 supports English only —
no Russian or other non-bundled languages.

**Summarizer (`summarizerProvider` in settings):** Optional but recommended for
long responses.

| Mode | Setup |
|------|-------|
| `none` | None — long responses are truncated at the first sentence after 300 chars |
| `haiku` | Set `anthropicApiKey` — uses `claude-haiku-4-5` |
| `ollama` | Set `ollamaHost` / `ollamaPort` — picks the largest loaded model, POSTs to `/api/chat` |

The summarizer is context-aware: turns that wrote to files get a deterministic
template ("I updated X. See details below.") and skip the LLM entirely; longer
responses go through a two-pass tighten + list-stripping pipeline.

**Source:** `lib/tts.ts`, `app/api/tts/route.ts`, `components/RichTextEditor.tsx`
(dictation).

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript
- **Styling**: Tailwind CSS 4, shadcn/ui components (Radix UI primitives)
- **Editor**: TipTap (rich text input + notes)
- **Canvas**: Drawflow
- **AI**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — one persistent streaming `query()` per session via `SdkSessionManager`; the legacy Claude CLI child-process path (`SessionManager`) remains as a fallback
- **Code Search**: codemogger (local semantic + keyword search via MCP)
- **Fonts**: Geist Sans / Geist Mono

## Data Storage

| Data | Location |
|------|----------|
| Session transcripts | `~/.claude/projects/<slug>/<sessionId>.jsonl` (written by the Claude Code subprocess) |
| Chat history | `~/.claude/history.jsonl` (Claude Code global, also appended by Fury) |
| **Transcript archive** | **`~/.claude/fury.db` (SQLite, Fury managed)** |
| Workflows | `.claude-workflows/*.json` (project-local) |
| UI state | `.claude-ui-state/state.json` (project-local) |
| App settings | `.claude-ui-state/settings.json` (project-local) |
| Saved prompts | `.claude-prompts/*.json` (project-local) |
| Session notes | `~/.claude-session-notes/*.md` (user home) |
| MCP servers | `~/.claude.json` (user scope) or `.mcp.json` (project scope), created and managed by Claude CLI via `claude mcp add/remove` |
| Code search index | `~/.codemogger/index.db` (codemogger, user home) |
| Theme | `localStorage` (browser) |

### Transcript Database

Claude Code auto-deletes session JSONL files after 30 days (controlled by `cleanupPeriodDays` in `~/.claude/settings.json`). Fury maintains an independent SQLite archive at `~/.claude/fury.db` so transcripts survive cleanup.

**How it works:**

The database is populated automatically through four triggers:
1. **Startup scan** — On first connection, scans all `~/.claude/projects/*/` JSONL files and archives any that are new or changed.
2. **History watcher** — When `history.jsonl` changes (any session, including external CLI), archives the recently-active sessions.
3. **Transcript watcher** — When a watched session's JSONL changes during a live session, archives it immediately.
4. **Archive-on-read** — When `/api/transcript` loads a JSONL, persists it as a fire-and-forget side effect.

A SHA-256 hash per session ensures duplicate archival is a no-op. When a JSONL file is missing (deleted by cleanup), the transcript API falls back to SQLite transparently. The history list merges archived sessions so cleaned-up sessions remain visible.

**Schema** (core tables):
- `sessions` — session metadata: project path, display text, message count, content hash, status (`active`/`archived`), and a JSON `metadata` blob (model, context tokens/window, token totals, compaction count)
- `messages` — parsed transcript messages (role, content, timestamp, turn index)
- `raw_jsonl` — original JSONL lines preserved for full-fidelity restoration
- `usage_events` — per-message token usage (input / output / cache read + write, `is_sidechain` for subagents) that powers the Stats tab, retained even after a session is archived

Plus internal tables for the model catalog and pricing cache.

**Technology:** `@libsql/client` (Turso/libSQL) with WAL mode for concurrent read/write safety.

**Manual population:**

```bash
npx tsx scripts/populate-db.ts           # Archive all existing JSONL files
npx tsx scripts/populate-db.ts --dry-run # Preview without writing
npx tsx scripts/populate-db.ts --verbose # Show per-file details
```

## Session Lifecycle

Fury runs sessions on the **Claude Agent SDK** (`sdkSessionsEnabled`, on by default). Each session is backed by **one long-lived streaming `query()`** and its warm CLI subprocess, tracked in memory by `SdkSessionManager`:

1. **Creating a session** — A frontend operation: a UUID is generated and held in React state. Nothing spawns and no server-side state is created until the first message; the session materialises on disk (and in the manager) when the first prompt is sent.

2. **Sending a message** — The first send opens a persistent `query()` with a streaming-input generator and spawns the CLI subprocess; the prompt is pushed into that input stream and the response streams back over SSE. Subsequent messages reuse the **same warm query and process** — no cold start per turn. Per-turn tokens, context window, and partial output are tracked in memory and emitted live.

3. **Switching sessions** — A frontend operation: the UI swaps which transcript is displayed. The other session's query keeps running in the background — its output is persisted to JSONL and its health/SSE events continue, so a background turn (or a subagent it dispatched) stays "live" with its dots still bouncing.

4. **Conversation continuity** — The live query holds context in-process; across a server restart the session re-opens with the SDK's `resume`, replaying the archived transcript. Rewind uses the SDK's native `resume` + `resumeSessionAt`.

5. **Model, stop & stuck handling** — The model can be switched mid-session (`setModel`, replayed into the query). Stop/interrupt aborts the current turn while leaving the session resumable; a hang watchdog surfaces a stuck turn so it can be killed. Background tasks (subagents, `run_in_background` Bash, Monitor) drive their own turns via injected `<task-notification>`s.

6. **Parallel sessions** — Multiple sessions run concurrent warm queries, each with its own subprocess and session UUID. The `activeSessionRef` mechanism ensures only the currently-viewed session's SSE handler updates the display, preventing cross-session contamination. Deleting a session terminates its warm process.

> **Legacy CLI path** — With `sdkSessionsEnabled` off, Fury falls back to the original stateless model: a short-lived `claude --print --session-id <uuid>` (`--resume` for follow-ups) is spawned per prompt via `SessionManager`, with conversation continuity managed by the CLI re-reading the JSONL. The SSE stream shape is identical either way, so the frontend keeps calling `/api/claude` regardless.

## Getting Started

### Prerequisites

- Node.js 20+
- Claude Code CLI installed and authenticated (`claude` command available in PATH) — used by both the Agent SDK and the legacy fallback path

### Install & Run

```bash
cd Fury
npm install
npm run dev
```

Open [http://localhost:3879](http://localhost:3879) in your browser.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with Turbopack on port 3879 |
| `npm run build` | Production build |
| `npm start` | Start production server on port 3879 |
| `npm run lint` | Run ESLint |
| `npm test` | Run the Vitest unit suite (fast, no server) |
| `npm run test:e2e` | Run the Playwright browser/E2E suite (needs the dev server) |
| `npx tsx scripts/populate-db.ts` | Populate transcript database from existing JSONL files |

### Testing

Fury has two test layers — a fast [Vitest](https://vitest.dev) unit suite (`tests/unit/`) and a
[Playwright](https://playwright.dev) browser suite (everything else under `tests/`), including a
few **live drives** that run real Claude turns and spend tokens.

See **[`tests/README.md`](tests/README.md)** for the full breakdown: how to run each layer, which
specs are token-spending live drives, the shared drive harness, and the directory-by-directory map.
