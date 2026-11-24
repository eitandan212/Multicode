# MultiCode

Connect the AI accounts you already have — **subscriptions or API keys** — and let them
build your project together as a crew.

* An **Architect** splits your request into tasks with clear file ownership.
* **Builders** (as many as you connect) write the code **in parallel**.
* A **Reviewer** checks the result and sends fixes back until it's approved.
* You watch every agent stream live and try the result in the built-in preview.

## Connect your AI

| You have | Choose | What MultiCode uses |
|---|---|---|
| Claude Pro / Max | Claude subscription | `claude` (Claude Code CLI) |
| ChatGPT Plus / Pro | ChatGPT subscription | `codex` (Codex CLI) |
| Google AI Pro / free Google account | Google subscription | `gemini` (Gemini CLI) |
| Anthropic / OpenAI / Gemini API key | the matching API | official SDKs |
| OpenRouter, Groq, DeepSeek, Ollama, LM Studio… | OpenAI-compatible API | any `/v1` endpoint |

Subscriptions don't come with API keys, so MultiCode drives each vendor's official CLI
on your machine. Install the CLI and sign in once:

```bash
npm i -g @anthropic-ai/claude-code   # then run: claude
npm i -g @openai/codex               # then run: codex login
npm i -g @google/gemini-cli          # then run: gemini
```

## Run it

Requires Node.js 20+.

```bash
npm install
npm run build
npm start            # → http://localhost:4317   (add -- --open to open the browser)
```

For development (`tsx watch` + Vite with hot reload): `npm run dev`, then open http://localhost:5173.

Your projects live in `~/.multicode/projects/<name>` (override with `MULTICODE_HOME`).

## Security

* The server only listens on `127.0.0.1` and rejects non-loopback `Host` headers.
* State-changing API calls require an `X-MultiCode` header (blocks cross-site requests).
* API keys are stored in `~/.multicode/config.json` with `0600` permissions and are never sent back to the browser.
* Model-written file paths are confined to the project folder (`..`, absolute paths, `.git` and `node_modules` are refused).
* The preview runs in a sandboxed, opaque origin, so generated code cannot call MultiCode's API.
* CLI agents run with edit-only permissions (`acceptEdits` / `workspace-write` / `auto_edit`), and read-only for planning and review. MultiCode never passes "bypass all permissions" flags.

## Tests

```bash
npm test         # parsers, path safety, scheduler, full crew run, HTTP guards, SSE
npm run typecheck
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.
