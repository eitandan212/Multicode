<p align="center"><img src="assets/brand/logo-reference.png" width="520" alt="MultiCode: Multi-engine vibe coding"></p>

# MultiCode

**One workspace. Many engines.**

Connect the AI accounts you already have — **subscriptions or API keys** — and let them
build your project together as a crew.

* A **Dispatcher** plans the work and assigns every task to the best-fitting agent, weighing
  each member's specialty and cost (free → subscription → pay-per-token). One click makes a
  **free OpenCode model** your dispatcher, so paid models spend their time building.
* **Builders** write the code **in parallel**. Each member can run up to 4 agents of its own and
  carry its own specialty or instructions.
* Every task is **verified**: an agent that writes nothing, goes silent (4 min) or runs too long
  (15 min) is stopped and its task is **reassigned** to another agent.
* A **Reviewer** checks the result and sends fixes back to the agent that wrote the file.
* **Undo** any thread (like rewind in Claude Code or undo in Codex); edits made after it are
  detected and never silently overwritten.
* **Sync across harnesses:** shared instructions, MCP servers and project memory reach Claude Code,
  Codex, Gemini CLI, Qwen Code and OpenCode through the files each one reads.
* **Plugins**, wired into every harness automatically (pinned versions):
  * **Memory graph** (on): a shared knowledge graph; MultiCode records every thread in it.
  * **AI browser** (on): Playwright MCP, limited to the app preview unless you allow any website.
  * Chrome DevTools, live library docs (Context7), sequential thinking.
  * **Desktop apps (agent-desktop)**, **Computer control** and **Desktop Commander**: off; turning them on needs an explicit confirmation. agent-desktop ([vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop), Apache-2.0) operates desktop apps through the accessibility tree, without screenshots.
* **Skill packs** (Agent Skills / `SKILL.md`): quality, web craft, testing, Node & TypeScript, Python,
  Roblox & Luau. In Auto they switch on from your request and the project's files, land in
  `.claude/skills`, `.agents/skills`, `.gemini/skills`, `.qwen/skills`, and are inlined for API agents.


Prompt caching can be checked against the real Anthropic API: **Check caching (real API)** on an Anthropic connection, or `npm run build && ANTHROPIC_API_KEY=... npm run verify:cache` (it refuses to run without a key; two short calls, a few cents).

How it compares with Claude Code and Codex, feature by feature: [docs/PARITY.md](docs/PARITY.md).

## Connect your AI

| You have | Choose | What MultiCode uses |
|---|---|---|
| Claude Pro / Max | Claude subscription | `claude` (Claude Code CLI) |
| ChatGPT Plus / Pro | ChatGPT subscription | `codex` (Codex CLI) |
| Google AI Pro / free Google account | Google subscription | `gemini` (Gemini CLI) |
| Anthropic / OpenAI / Gemini API key | the matching API | official SDKs |
| OpenRouter, Groq, DeepSeek, Ollama, LM Studio… | OpenAI-compatible API | any `/v1` endpoint |
| Nothing yet — start free | OpenCode | `opencode` with its free models (e.g. `opencode/big-pickle`) |
| GitHub Copilot, or any of 75+ providers | OpenCode | `opencode auth login`, then pick `provider/model` |
| A free Qwen account | Qwen Code | `qwen` |
| No paid account at all: 80+ free providers | OpenAI-compatible → **FreeLLMAPI** preset | [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT) running on your computer |
| Any other coding agent: Copilot, Cursor, Goose, Kiro, Qoder, Cline, Junie, Amp, Devin… | Any ACP agent | the [Agent Client Protocol](https://agentclientprotocol.com) registry |

Subscriptions don't come with API keys, so MultiCode drives each vendor's official CLI on your
machine, connected the way T3 Code connects them: **Claude Code through the official Claude Agent
SDK** (typed streaming, usage and cost, and every tool call checked by MultiCode's own policy) and
**Codex through `codex app-server`**, Codex's JSON-RPC protocol (sign-in checked up front, the
model list read from Codex, approvals answered by policy). Codex and every ACP agent run on
**T3 Code's own protocol clients**, `effect-codex-app-server` and `effect-acp`, copied from the
T3 Code repository under its MIT license (see `server/vendor/t3code`), so every message is checked
against the same generated schemas T3 Code uses. If either can't start (for example an
older Codex), MultiCode falls back to the plain CLI mode by itself. Install the CLI and sign in once:

```bash
npm i -g @anthropic-ai/claude-code   # then run: claude
npm i -g @openai/codex               # then run: codex login
npm i -g @google/gemini-cli          # then run: gemini

# Open-source agents
npm i -g opencode-ai                 # free models work immediately
npm i -g @qwen-code/qwen-code        # then run: qwen
```

In the crew editor, the model field suggests every model the agent offers (OpenCode lists 200+).

### FreeLLMAPI: a whole crew for free

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) puts the free tiers of 80+ providers behind
one OpenAI-compatible endpoint, with routing and failover. Run it on your computer, add your free
provider keys in its dashboard, then in *Connections → OpenAI-compatible* press **FreeLLMAPI**
(fills `http://localhost:3001/v1` and the `auto` model) and paste its unified `freellmapi-…` key.
**Auto crew** then builds a crew that costs nothing: `auto:smart` plans, `auto` builds with three
agents (your `auto:coding` profile if you made one), and `fusion` (several models plus a judge)
reviews. MultiCode counts the endpoint as free, so it also becomes the free manager.

### Any ACP agent

Like T3 Code, MultiCode speaks the open **Agent Client Protocol**. *Connections → Any ACP agent*
lists every agent in the public ACP registry (45+). Agents shipped through npm or uv run with
`npx`/`uvx`; agents shipped as downloads are installed on **Install** into MultiCode's data folder,
after checking the registry's SHA-256. You can also connect any ACP command of your own.

MultiCode is the ACP client, so it decides what an agent may do: file reads and writes go through
MultiCode and stay inside the project (writes only in edit tasks), reading and searching are
allowed, file edits are allowed in edit tasks, and shell commands, web fetches and unknown tools
are refused. Each agent uses its own sign-in; run it once in a terminal if it asks you to log in.

## Run it

Requires Node.js 20+.

```bash
npm install
npm run build
npm start            # → http://localhost:4317   (add -- --open to open the browser)
```

For development (`tsx watch` + Vite with hot reload): `npm run dev`, then open http://localhost:5173.

Your projects live in `~/.multicode/projects/<name>` and thread history in `~/.multicode/runs`
(override the folder with `MULTICODE_HOME`). Threads, their agent output and their diffs survive restarts.

On first launch a short tutorial walks you through it: connect an AI, meet your crew, name your
first project (MultiCode doesn't create one for you), and ask for something, from scratch or from
an example. Each step ticks itself off from what you actually did. Skip it any time; bring it back
from **Settings → Tutorial** or `Ctrl K` → *Show the tutorial*.

### Make it yours

**Settings** (bottom of the sidebar) holds Connections, Crew, Savings & safety, Plugins & skills,
Sync and Appearance. **Appearance** (or `Ctrl K` → Appearance): theme (system, light, dark),
accent colour (6 presets or any colour), font, interface size, animations, background ribbons (off by default) and
the opening animation. Saved in your browser and applied before the first paint.

### Shortcuts

| Keys | Action |
|---|---|
| `Ctrl K` / `⌘K` | Command palette: jump to any thread or project, open crew, connections, preview, files, changes |
| `Enter` / `Shift Enter` | Send to the crew / new line |

## Desktop app (Windows installer)

**Download:** [`downloads/MultiCode-Setup-0.3.15.exe`](downloads/MultiCode-Setup-0.3.15.exe)
(open it on GitHub and press *Download raw file*), run it, and MultiCode opens from the Start menu.
After that, MultiCode updates itself: when a new version is out, an **Update** button appears at the
bottom of the sidebar (it reads `downloads/latest.json`, checks the installer's SHA-256, installs
silently and reopens).
SHA-256 `441319f678d1b9e2dbed3c6522566abac9cd5ffe10657289de76d0b9fbc18594`. Windows SmartScreen may
warn because the installer isn't signed yet: choose *More info → Run anyway*. To build the installer yourself:

```bash
npm run desktop     # run MultiCode as a desktop window (Electron)
npm run dist:win    # build release/MultiCode-Setup-<version>.exe
```

`dist:win` packages the app with electron-builder and wraps it with NSIS (`build/installer.nsi`),
so it builds on Windows, macOS or Linux without Wine; it needs `makensis`
(`winget install NSIS.NSIS`, `brew install nsis` or `apt install nsis`). The installer is per-user
(no administrator prompt), installs to `%LOCALAPPDATA%\Programs\MultiCode`, adds Start menu and
desktop shortcuts and an entry in *Apps & features*. Uninstalling removes the program only; your
projects and settings in `%USERPROFILE%\.multicode` stay. The installer isn't code-signed, so
Windows SmartScreen asks once: *More info → Run anyway*.

## Who works: Auto, your crew, or one model

The button next to *Send* chooses who works on the next request:

* **Auto**: every connection joins. MultiCode ranks the models: the strongest plans, the next
  strongest reviews, the rest build in parallel, and the dispatcher gives each task to the
  best-fitting builder.
* **My crew**: the agents and roles you set in *Edit crew*.
* **Single model**: one model (for example Claude Opus 5.5 through Claude Code) does every step
  itself: it plans the work first, builds it, then reviews and fixes its own result (as many
  rounds as the *Review* setting says).

Your choice is remembered in this browser.

### Specialist agents

*Crew → Add agent* opens a library of specialists: Lead planner; Frontend, Backend and
Roblox/Luau engineers, UI designer, Test engineer, Debugger and Docs writer; and Code, Security,
Performance and Accessibility reviewers. Each one runs on any model you have connected (it keeps
the model's name; the specialty shows as a tag), and its specialty guides the planner, the manager's
task routing and the agent itself. Several reviewers check each round in parallel; the work is
approved only when all of them approve, and their issues go back to the builders as fixes.

### The manager (free)

A free or cheap **manager** model runs the crew, so your strong models spend their effort on
thinking and building: it assigns every task to the builder that fits best (with a reason you can
see), and in **Auto** it chooses who plans, builds and reviews. The planning itself always stays
with the strongest model. By default MultiCode uses a connection on a free model or a local
server, otherwise OpenCode's free *Big Pickle*; pick another or turn it off in *Crew → Manager*.
If the manager fails or answers nonsense, the run simply continues with the defaults.

## IDE view

Switch between **Chat** and **IDE** at the top (or `Ctrl K` → *Switch to IDE view*). The IDE is
built on [Monaco](https://github.com/microsoft/monaco-editor) (MIT), the editor inside VS Code,
bundled locally so it works offline: file explorer, tabs with unsaved markers, syntax
highlighting and IntelliSense for web languages, find/replace, minimap, sticky scroll and the F1
command list. `Ctrl S` saves. The crew stays docked on the right, so you can edit and ask in the
same place. Files the crew changes are marked **M** and open tabs update live; if you edited a
file the crew also changed, you choose whose version to keep. While the crew is working on the
project the editor is read-only, so nobody overwrites anybody.

## Save credits, never stall

* **Free fallback:** when a subscription or API key hits its usage limit (429, quota, "usage limit
  reached"…), a free OpenCode model takes over that agent's work immediately. The account is skipped
  until its limit resets (parsed from the error, else 1 h; 2 min for short rate limits).
* **Economy mode:** free and flat-rate members get the work first, the cheapest member reviews
  (one round), and agents receive smaller context.
* **Token meter:** every thread shows tokens used, how many came from free models, and cost where
  the provider reports it.
* **Auto crew from one key:** connect one multi-model key (e.g. OpenRouter) and press *Auto crew*:
  free models dispatch and review, OpenRouter's Auto Router builds with 3 parallel agents.

## Safety modes

* **Direct, with undo** (default): agents edit the project; every thread can be undone.
* **Sandbox:** agents work on a copy without your secrets; you review and *Apply* or *Discard*.
* **Plan only:** agents read and plan, nothing changes.
* **Protected files** (`.env`, keys, `secrets/**`, your own patterns) are never sent to models,
  are left out of sandboxes, and any change to them is rolled back immediately.

## MultiDesign

Switch the composer to **MultiDesign**: up to four models each design their own take (calm minimal,
bold expressive, warm editorial, dark technical) in separate sandboxes, at the same time. Compare
the live previews side by side and click *Use this design*.

## Sync across harnesses

| Harness | Instructions + memory | MCP servers |
|---|---|---|
| Claude Code | `CLAUDE.md` | `.mcp.json` |
| Codex | `AGENTS.md` | passed per run (`-c mcp_servers.*`) |
| Gemini CLI | `GEMINI.md` | `.gemini/settings.json` |
| Qwen Code | `QWEN.md` | `.qwen/settings.json` |
| OpenCode | `AGENTS.md` | `opencode.json` |

MultiCode edits only its own marked block and the MCP entries it created; your own content is
kept. Secrets are stored in MultiCode's private config and injected into agent processes; project
files only reference variable names.

## Security

* The server only listens on `127.0.0.1` and rejects non-loopback `Host` headers.
* State-changing API calls require an `X-MultiCode` header (blocks cross-site requests).
* API keys are stored in `~/.multicode/config.json` with `0600` permissions and are never sent back to the browser.
* Model-written file paths are confined to the project folder (`..`, absolute paths, `.git` and `node_modules` are refused).
* The preview runs in a sandboxed, opaque origin, so generated code cannot call MultiCode's API.
* CLI agents run with edit-only permissions (`acceptEdits` / `workspace-write` / `auto_edit` / `auto-edit`), and read-only for planning and review. OpenCode runs with its shell and web tools removed. MultiCode never passes "bypass all permissions" flags.

## Tests

```bash
npm test         # parsers, path safety, scheduler, full crew run, HTTP guards, SSE
npm run typecheck
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

## Brand

| | |
|---|---|
| Graphite | `#0B0C0F` |
| Off-White | `#F5F4EF` |
| Cobalt (primary) | `#2563FF` |
| Amber (highlight) | `#F59E0B` |
| Type | Inter (Semibold / Medium / Regular) |

Logo, app icon and the brand sheet live in [`assets/brand/`](assets/brand/).

## Trademarks

Provider logos come from [@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT). Claude,
Claude Code, OpenAI, Codex, Gemini, Qwen, OpenCode and the other names and logos are trademarks of
their owners. MultiCode uses them only to show which service a connection uses and is not
affiliated with or endorsed by any of them.
