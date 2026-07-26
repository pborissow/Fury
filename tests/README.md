# Fury Tests

Fury's tests come in two layers:

| Layer | Runner | Location | Server needed? | Spends tokens? | Speed |
|-------|--------|----------|:---:|:---:|-------|
| **Unit** | [Vitest](https://vitest.dev) | `tests/unit/**/*.test.ts` | no | no | ~10s for all 200+ |
| **Browser / E2E** | [Playwright](https://playwright.dev) | `tests/**/*.spec.ts` (all dirs except `unit`) | yes (`:3879`) | some (the "live drives") | seconds to minutes |

> **Rule of thumb:** logic that can be made pure lives behind a unit test; anything that needs the running app, the browser DOM, or a real Claude turn is a Playwright spec.

## Running the tests

### Unit (fast, deterministic, no server)

```bash
npm test          # alias: npm run test:unit  → vitest run
npx vitest run tests/unit/freshness.test.ts      # a single file
npx vitest            # watch mode
```

Config: [`vitest.config.mjs`](../vitest.config.mjs) — includes `tests/unit/**/*.test.ts`, runs in the Node environment (no jsdom), and maps the `@/…` path alias to the repo root. These never start a server or a browser and never call Claude, so they're safe to run on every save.

### Browser / E2E (needs the dev server)

```bash
npm run test:e2e                                             # every non-unit spec
npm run test:e2e -- tests/editor                             # one directory
npm run test:e2e -- tests/live-sessions/freshness-leaf.spec.ts   # one file
npm run test:e2e -- tests/mcp/mcp-fixes.spec.ts --reporter=line
```

Config: [`playwright.config.ts`](../playwright.config.ts).

- **`testDir: ./tests`, `testIgnore: **/unit/**`** — Playwright runs everything under `tests/` *except* the Vitest unit folder.
- **`webServer`** auto-starts `npm run dev` on `http://localhost:3879` and **reuses an already-running server** (`reuseExistingServer: true`), so if you already have `npm run dev` up, the tests attach to it.
- **`headless: false`** — the suite runs headed by default; a browser window will open.
- The `test:e2e` script wraps `node --experimental-require-module …/@playwright/test/cli.js test` (needed to load the ESM Playwright CLI under this repo's toolchain); everything after `--` is passed straight through to the Playwright CLI.

**Prerequisites for E2E:**
- The dev server running (or lettable to start) on `:3879`.
- An **authenticated Claude CLI** (`claude` in PATH) — required by the *live drives* below, which start real Claude turns.

## ⚠️ Live drives — they spend tokens and take minutes

A handful of specs **POST a real turn to `/api/claude-sdk`** and let Claude actually work. They cost tokens and can each take from ~30s to a few minutes. Run them deliberately, not in a tight loop.

| Spec | What it proves |
|------|----------------|
| `live-sessions/background-task-reassert.spec.ts` | A background task (a `run_in_background` Bash) posts a `<task-notification>` that drives an **un-submitted** turn; the server re-asserts `processing` (dots stay on, partials stripped) instead of going dark. Asserts the `sdk.turn:reassert` + second `sdk.health:processing` signature from the fury-logs. |
| `live-sessions/freshness-leaf.spec.ts` | The prompt-cache "freshness leaf" stays pinned live-warm for the whole active window, then counts down from the true end (no false-stale). |
| `live-sessions/inflight-partials-health.spec.ts` | A long multi-tool turn never leaks its in-flight partial assistant messages as intermediary bubbles across health ticks; health events carry a `startedAt` strip anchor. |
| `live-sessions/resume-cleaned-session.spec.ts`, `resume-summary-fidelity.spec.ts` | Resuming a session restores/continues it faithfully. |
| `e2e/build-calculator.spec.ts`, `e2e/ask-user-question.spec.ts`, `e2e/model-selection.spec.ts`, `e2e/new-session-model.spec.ts` | Full user flows that involve a real turn (building an artifact, answering an `AskUserQuestion`, picking a model). |

How the live drives work — and why they're reproducible:

- Each drive runs in a **scratch project created *outside* the repo** at `../fury-e2e-*` (sibling of the `Fury/` checkout), wiped and recreated per run, so it never touches your working tree.
- They assert against **on-disk truth**: the session JSONL under `~/.claude/projects/…` and the correlated **`~/.claude/fury-logs/`** telemetry (see [`docs/logging-and-telemetry.md`](../docs/logging-and-telemetry.md)). The fury-logs are the source of truth for whether a fix *engaged* — e.g. a live turn can look fine in the DOM while the log shows the server never re-asserted `processing`.
- Every drive cleans up after itself in `afterAll` (deletes the session via the API, then prunes the JSONL, PID file, and `history.jsonl` entry).
- Shared scaffolding lives in **[`live-sessions/drive-helpers.ts`](live-sessions/drive-helpers.ts)** — `driveTurn`, `resetProjectDir`, `reapPidFiles`, `furyLogLinesFor`, `cleanupSession`, etc. Reuse it when adding a new drive rather than re-implementing the harness.

## Layout

```
tests/
├── unit/            # Vitest — pure logic, no server, no browser
│   └── fixtures/    #   sample JSONL etc. loaded by unit tests
├── live-sessions/   # Playwright — live SDK behavior + live-session detection
│   ├── drive-helpers.ts   # shared harness for the live drives (not a test)
│   └── find-session.ts    # sidebar-locator helper (not a test)
├── e2e/             # Playwright — end-to-end user flows (some drive real turns)
├── chat/            # Playwright — chat UI (transcript, sidebar, dialogs, TTS)
├── editor/          # Playwright — rich-text editor behavior
├── mcp/             # Playwright — MCP server management UI
└── auth-e2e.spec.ts # Playwright — login → app → logout
```

### `tests/unit/` — Vitest (25 files)
Deterministic coverage of the logic behind Fury's trickier subsystems, with no server or browser. Highlights:
- **SDK session manager**: `sdk-background-turn-reassert`, `sdk-error-surfacing`, `singleton-binding`, `handoff-ownership`, `sidechain-context`, `context-window-model-switch`, `health-startedat`, `strip-inflight-partials`.
- **Freshness / live state**: `freshness`, `live-sessions`, `archive-status`, `history-archived-filter`.
- **Models & provider switching**: `model-catalog`, `model-route-warm`, `warm-models`, `providerSwitch-detect` / `-failover` / `-rehydrate`, `pricing`.
- **Ask-user-question**: `ask-user-question-router`, `ask-user-question-serializer`.
- **Task notifications / TTS**: `task-notification-response`, `tts-preprocessing`, `tts-route`, `tts-singleton`.

Many of these pair with a small pure module extracted from a component/service specifically so it can be tested here — e.g. `lib/freshness.ts` ↔ `freshness.test.ts`, and `lib/transcriptStrip.ts` ↔ `strip-inflight-partials.test.ts`.

### `tests/live-sessions/` — Playwright (7 specs + 2 helpers)
Two flavors:
- **Live drives** (spend tokens — see the table above): `background-task-reassert`, `freshness-leaf`, `inflight-partials-health`, `resume-cleaned-session`, `resume-summary-fidelity`.
- **Live-session *detection*** (read-only APIs, no turn): `stale-detection` (dead/mismatched PIDs are excluded from `/api/live-sessions`, and UI badges match), `stuck-session` (a wedged session surfaces its recovery affordances).

### `tests/e2e/` — Playwright (5)
End-to-end flows: `build-calculator`, `ask-user-question`, `model-selection`, `new-session-model` (all drive a real turn), and `delete-to-archive` (UI-only).

### `tests/chat/` — Playwright (8)
Chat surface without a real turn: `compaction-detection`, `debug-sidebar`, `debug-transcript`, `dialog-maximize`, `pre-block-style`, and the TTS trio `tts-playback` / `tts-replay-timing` / `tts-services`.

### `tests/editor/` — Playwright (5)
Rich-text editor: `code-spellcheck`, `list-exit`, `list-toolbar`, `no-autolink`, `table-roundtrip`.

### `tests/mcp/` — Playwright (4)
MCP server management UI: `add-stdio-server`, `add-http-server`, `add-codesearch`, `mcp-fixes`.

### `tests/auth-e2e.spec.ts` — Playwright (1)
The full login → app → logout flow.

## Conventions

- **Unit test files** are `*.test.ts` under `tests/unit/`; Playwright specs are `*.spec.ts` anywhere else under `tests/`. The two never overlap (`testIgnore` keeps Playwright out of `unit/`; Vitest's `include` keeps it in).
- **Helper modules are plain `*.ts`, never `*.spec.ts`** (`drive-helpers.ts`, `find-session.ts`). Playwright's default `testMatch` only collects `*.spec.ts`, so helpers are importable without being run as tests.
- **Fixtures** (sample JSONL, etc.) live in `tests/unit/fixtures/`.
- **Prefer a unit test.** When you find a bug in component/route code, try to lift the decision into a pure function in `lib/` and cover it in `tests/unit/` — it's faster, deterministic, and free. Reach for a live drive only when the behavior genuinely needs a running turn.
- **When you add a live drive**, build it on `drive-helpers.ts`, keep its scratch project outside the repo (`../fury-e2e-<name>`), clean up in `afterAll`, and assert the real outcome from `~/.claude/fury-logs/` — not just the DOM.
