# Fury IDE

A prototype IDE for AI-assisted development built with Next.js and Claude Code. Fury IDE provides a web-based interface for interacting with the Claude CLI, managing chat sessions, building visual workflows, and organizing project notes.

## Features

### Chat Interface
- **Claude CLI sessions** - Sessions are native Claude CLI sessions using `--session-id` and `--resume`, with full conversation context managed by the CLI
- **Unified session list** - Browse all sessions from `~/.claude/history.jsonl` with live session indicators
- **Streaming responses** - Real-time streamed output from Claude CLI with tool use activity indicators
- **Markdown rendering** - Assistant responses rendered with syntax highlighting (via `react-markdown`, `remark-gfm`, `rehype-highlight`)
- **Long conversation warnings** - Visual indicator when sessions exceed 50 messages
- **Rich text input** - TipTap-based editor with code block support (Enter to send, Shift+Enter for newline)
- **Stop/Kill controls** - Abort in-flight requests or kill stuck Claude CLI processes
- **AskUserQuestion support** - Interactive dialog when Claude requests user input via the AskUserQuestion tool

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

### General
- **Light/Dark theme** - Toggle via toolbar button, persisted in localStorage
- **Directory picker** - Browse filesystem to select project directories for new sessions
- **Resizable panels** - All panels are drag-resizable via `react-resizable-panels`
- **UI state persistence** - Active tab and workflow selection restored across page reloads

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript
- **Styling**: Tailwind CSS 4, shadcn/ui components (Radix UI primitives)
- **Editor**: TipTap (rich text input + notes)
- **Canvas**: Drawflow
- **AI**: Claude CLI (`claude` command) spawned as child processes via `SessionManager`
- **Fonts**: Geist Sans / Geist Mono

## Architecture

```
app/
  page.tsx              # Main UI (single-page app)
  layout.tsx            # Root layout (metadata, fonts, dark class)
  globals.css           # Theme variables, prose styles, animations
  api/
    claude/route.ts     # POST - Streams Claude CLI output via SSE
    history/route.ts    # GET/DELETE - Read/clear ~/.claude/history.jsonl
    transcript/route.ts # GET - Read session transcript from CLI JSONL files
    live-sessions/route.ts # GET - List currently active CLI sessions
    tree/route.ts       # GET - Build file tree for a directory
    directories/route.ts# GET - Browse filesystem directories
    notes/route.ts      # GET/POST/DELETE - Per-project notes
    health/route.ts     # GET/POST - Session health check / kill stuck process
    workflows/route.ts  # CRUD for workflow persistence
    prompts/route.ts    # CRUD for saved prompts
    ui-state/route.ts   # GET/POST - Persist active tab & workflow

lib/
  sessionManager.ts     # Singleton that spawns/queues Claude CLI processes (--session-id/--resume)
  workflowPersistence.ts # Read/write workflows to .claude-workflows/
  uiStatePersistence.ts  # Read/write UI state to .claude-ui-state/
  promptPersistence.ts   # Read/write saved prompts to .claude-prompts/
  recent-directories.ts  # Extract recent dirs from history & workflows
  utils.ts               # cn() utility for class merging

components/
  DrawflowCanvas.tsx     # Drawflow wrapper with drag-drop node creation
  WorkflowsPanel.tsx     # Workflow list sidebar (create/rename/delete/load)
  NodeChatModal.tsx      # Modal chat interface for workflow nodes
  FileTree.tsx           # Recursive file tree display
  DirectoryPicker.tsx    # Filesystem directory browser dialog
  RichTextEditor.tsx     # TipTap editor (chat input + notes)
  AskUserQuestionDialog.tsx # Interactive dialog for Claude's AskUserQuestion tool
  NotesEditor.tsx        # Notes-specific editor wrapper
  PromptsPanel.tsx       # Saved prompts panel
  ui/                    # shadcn/ui primitives (button, input, dialog, etc.)
```

## Data Storage

| Data | Location |
|------|----------|
| Session transcripts | `~/.claude/projects/<slug>/<sessionId>.jsonl` (Claude CLI managed) |
| Chat history | `~/.claude/history.jsonl` (Claude CLI global, also appended by Fury) |
| Workflows | `.claude-workflows/*.json` (project-local) |
| UI state | `.claude-ui-state/state.json` (project-local) |
| Saved prompts | `.claude-prompts/*.json` (project-local) |
| Session notes | `~/.claude-session-notes/*.md` (user home) |
| Theme | `localStorage` (browser) |

## Session Lifecycle

Fury does **not** maintain long-running Claude processes. Sessions are stateless on the server between messages:

1. **Creating a session** — Purely a frontend operation. A UUID is generated and stored in React state. No Claude process is spawned, no server-side state is created. The session only materialises on disk when the first message is sent.

2. **Sending a message** — A `claude --print --session-id <uuid>` process is spawned (or `--resume <uuid>` for subsequent messages). It handles **one prompt**, streams the response back via SSE, writes to the JSONL transcript file, and exits. There is no persistent process per session.

3. **Switching sessions** — Purely a frontend operation. The UI swaps which transcript is displayed by loading the target session's JSONL from disk. No processes are spawned or terminated. If a Claude process is mid-response when you switch away, it continues running to completion in the background — its SSE handler simply stops updating the display, and the data is persisted to JSONL for when you return.

4. **Conversation continuity** — Managed entirely by the Claude CLI via `--resume <uuid>`. On each message, the CLI re-reads the session's JSONL file to reconstruct conversation context. Fury itself does not track conversation history.

5. **Parallel sessions** — Multiple sessions can process messages concurrently. Each spawns its own short-lived Claude process with a distinct session UUID. The `activeSessionRef` mechanism ensures only the currently-viewed session's SSE handler updates the display, preventing cross-session contamination.

## Getting Started

### Prerequisites

- Node.js 20+
- Claude CLI installed and authenticated (`claude` command available in PATH)
- **Important:** Claude CLI auto-deletes session transcripts after 30 days by default. To preserve chat history indefinitely, add `"cleanupPeriodDays": 99999` to `~/.claude/settings.json`.

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
