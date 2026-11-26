# MultiCode vs Claude Code and Codex

What the two reference tools offer, and where it lives in MultiCode. ✅ = available, ➕ = MultiCode
goes further, ◐ = partly, — = not available (with the reason).

| Feature | Claude Code | Codex | MultiCode |
|---|---|---|---|
| Chat that edits your project | ✅ | ✅ | ✅ MultiBuild: plan → parallel builders → review |
| Several models on one task | — | — | ➕ crew of any connected models; MultiDesign variants |
| Conversation memory in a thread | ✅ | ✅ | ✅ follow-ups remember earlier turns and answers |
| Resume earlier threads | ✅ `/resume` | ✅ | ✅ sidebar, search, settle |
| Type while it works (queue) | ✅ | ✅ | ✅ queued follow-ups start by themselves |
| Stop a run | ✅ | ✅ | ✅ |
| Slash commands | ✅ | ✅ | ✅ `/new /review /plan /sandbox /design /sleep /export /mcp /usage …` |
| Custom commands (Markdown files) | ✅ `.claude/commands` | ✅ `~/.codex/prompts` | ✅ reads both |
| `@` file mentions | ✅ | ✅ | ✅ autocomplete; files go to the planner only |
| Images / screenshots | ✅ | ✅ | ✅ paste, drop or attach; vision models see them |
| Plan-only mode | ✅ | ✅ | ✅ `/plan` (Plan only safety) |
| Approvals (ask / auto-edit / all) | ✅ | ✅ | ✅ per change and per tool, with diffs |
| Sandbox | ◐ | ✅ | ✅ sandbox copy, apply or discard |
| Undo / checkpoints | ✅ | ◐ | ✅ undo a run's changes |
| Code review of your changes | ✅ `/review` | ✅ `/review` | ✅ `/review` (git diff, secrets stripped) |
| Git: status, commit, push | via agent | ✅ | ✅ Changes tab |
| Diff view | ✅ | ✅ | ✅ |
| MCP servers | ✅ | ✅ | ✅ shared with every agent; one-click catalog |
| Import MCP from other tools | — | — | ➕ Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, Windsurf |
| Project instructions (CLAUDE.md / AGENTS.md) | ✅ | ✅ | ✅ written for every harness at once |
| Skills | ✅ | ✅ | ✅ skill packs synced to every harness |
| Memory | ✅ | ◐ | ✅ memory graph per project |
| Reasoning effort | ✅ | ✅ | ✅ per connection (Claude Code, Codex, Anthropic API) |
| Model choice | ✅ | ✅ | ✅ per connection, team picker, Auto |
| Usage and limits | ✅ `/usage` | ✅ | ✅ plan windows and reset times |
| Prompt caching | ✅ | ✅ | ✅ Anthropic system prompts cached; cached tokens shown |
| Export a conversation | ✅ `/export` | — | ✅ `/export` to Markdown |
| Notifications | ✅ | ✅ | ✅ desktop notification and optional chime |
| Keyboard shortcuts, command palette | ✅ | ✅ | ✅ Ctrl+K and more |
| IDE view (editor, files, terminal) | via IDE plugins | ✅ | ✅ built in |
| Live preview | — | — | ➕ project preview panel |
| Works unattended | ◐ headless | ✅ cloud tasks | ✅ Sleep mode keeps the computer awake |
| Sign in with subscriptions | ✅ | ✅ | ✅ Claude, ChatGPT (Codex), Antigravity in one click |
| Any API / local model | — | ◐ | ➕ Anthropic, OpenAI, Gemini, any OpenAI-compatible, Ollama, ACP agents |
| Automatic updates | ✅ | ✅ | ✅ verified (SHA-256) one-click update |
| Hooks (run scripts on events) | ✅ | ◐ | ◐ a check command per project (e.g. `npm test`) runs after each build; a failure becomes a fix. Each harness's own hooks still run inside it |
| Cloud tasks / remote runs | — | ✅ | — MultiCode runs on your computer |
