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
Three panes: Crew (left) · Mission timeline (center: plan, live agent streams, review) ·
Workspace (right: live preview iframe + file browser). Collapses to tabs on mobile.

## Non-goals (v1)
Hosted/cloud version, billing, git integration, Electron packaging (planned next).
