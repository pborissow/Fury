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

## Getting Started

### Prerequisites

- Node.js 20+
- Claude CLI installed and authenticated (`claude` command available in PATH)

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
