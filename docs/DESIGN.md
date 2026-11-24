# MultiCode — Design

## Intent
A vibe-coding app where you connect your own AI accounts — API keys **and** existing
subscriptions — and the connected models work together as a crew to build a project
from a plain-language request.

## Key constraint: subscriptions vs. API keys
Consumer subscriptions (Claude Pro/Max, ChatGPT Plus/Pro, Google AI Pro) do not give API
keys. The supported way to use them programmatically is each vendor's official CLI, which
signs in with the subscription:

| Subscription | CLI | Headless invocation |
|---|---|---|
| Claude | `claude` (Claude Code) | `claude -p … --output-format stream-json --verbose` |
| ChatGPT | `codex` (Codex CLI) | `codex exec --skip-git-repo-check -s workspace-write …` |
| Google | `gemini` (Gemini CLI) | `gemini -p … --approval-mode auto_edit` |

Therefore MultiCode is a **local app**: a Node server bound to `127.0.0.1` plus a web UI.
It drives the CLIs on the user's machine and calls APIs directly with the user's keys.

### Open-source agents
| Agent | License | Headless invocation | Notes |
|---|---|---|---|
| OpenCode (`opencode`) | MIT | `opencode run --format json --dir <project> --agent build\|plan -m provider/model` | 75+ providers, free models, Copilot login. Shell/web tools denied via `OPENCODE_CONFIG_CONTENT`. |
| Qwen Code (`qwen`) | Apache-2.0 | `qwen --approval-mode auto-edit\|plan -o text` | Free Qwen OAuth tier. |

Considered and not added yet:
* **T3 Code** (MIT) is a GUI over agents, i.e. a peer of MultiCode, not an agent to plug in.
  MultiCode follows the same idea: one local server that runs the agents and normalises
  their event streams into a single timeline.
* **Kilo CLI** (MIT, OpenCode fork): same CLI shape, but its shell tool could not yet be
  verified as deniable, so it is held back.
* **Crush** (FSL-1.1): no read-only mode in headless runs.
* **Aider** (Apache-2.0): Python; candidate for a later adapter.

Agents that read the `PWD` environment variable get it set to the project folder.

## Providers
One interface (`Provider.generate(req, onDelta, signal)`), two families:

* **API**: Anthropic, OpenAI, Google Gemini, and any OpenAI-compatible endpoint
  (OpenRouter, Groq, DeepSeek, Ollama, LM Studio…).
* **CLI (subscription)**: Claude Code, Codex, Gemini CLI. Detected on `PATH`.

## The crew
Members = (name, role, provider, model). Roles:

1. **Architect** – turns the request into a plan of tasks with disjoint file ownership (JSON).
2. **Builders** (one or many) – execute tasks in parallel.
   * API builders return `<file path="…">full content</file>` / `<delete path="…"/>` blocks
     that MultiCode applies safely inside the project folder.
   * CLI builders edit the project folder themselves; MultiCode detects changes by snapshot.
3. **Reviewer** – reads the changed files and returns `{approved, issues[]}`. Issues become
   fix tasks; loop up to `maxReviewRounds` (default 2).

Missing roles fall back to any connected member, so a single connection is a valid crew.

Scheduling: tasks run in parallel across builders; two tasks touching the same file never
run at the same time (per-file locks).

## Security
* Server listens on `127.0.0.1` only. Host header must be loopback (DNS-rebinding guard);
  mutating requests require a custom header (blocks cross-site form/fetch CSRF).
* Keys stored in `~/.multicode/config.json` with mode `0600`; never returned to the UI (masked).
* All file writes resolved inside the project root; traversal, absolute paths and `.git` rejected.
* CLI builders run with edit-only permissions (no blanket "bypass all" flags).

## UI
Layout in the spirit of T3 Code (MIT); palette and motion in the spirit of Qoder. MultiCode uses
its own name, logo, illustrations and code; no assets or trademarks of either product are used.

* **Palette:** warm off-white / warm charcoal neutrals, forest-green primary (`#255a41`), leaf-green
  accent; crew colours are the only other hues. Type: Instrument Sans + JetBrains Mono.
* **Motion** (one easing, `cubic-bezier(.22,1,.36,1)`): new thread items settle in from a slight blur;
  running titles carry a light sweep; a breathing dot marks thinking agents; queued tasks pulse;
  dialogs rise from 95%; the start screen's ribbons draw in once. All of it is off under
  `prefers-reduced-motion`.

* **Sidebar:** projects with their threads, search, a "Working" group with elapsed time,
  and Connections / Crew at the bottom.
* **Thread:** breadcrumb `project / thread`; your request as a bubble; "Working for Ns";
  the plan as a checklist coloured by assignee; each agent call folded into one line
  (`›_ Agent  Task`) that expands to its live output; review verdicts; an "Edited N files" card
  with per-file line counts and a Review button that opens the diff.
* **Composer:** rounded card with the crew chip and a round send/stop button; a meta row
  underneath holds the project, a task-progress bar while the crew works, and the review-rounds
  setting. Enter sends.
* **Side panel:** a crew card (members, Edit crew, Connections) and a Preview / Files / Changes card.
  Changes is a unified diff per thread (computed with jsdiff against a snapshot taken when the thread starts).
* **Command palette** (Ctrl/Cmd+K): threads, projects and every action, keyboard-driven.
* **History:** each thread is stored as `runs/<id>.json` (summary) + `runs/<id>.jsonl` (event log) and
  replayed on demand; threads interrupted by a shutdown are closed with an explanation on the next start.
* Light and dark follow the system. On narrow screens the sidebar and panel become overlays.

## Non-goals (v1)
Hosted/cloud version, billing, git integration, an in-app terminal (it would expose a shell to the
browser UI), Electron packaging (planned next).
