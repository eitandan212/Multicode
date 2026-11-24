import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Connection } from "../config.js";
import { ProviderError, type DeltaHandler, type GenerateRequest, type Provider } from "./types.js";

type CliKind = "claude-cli" | "codex-cli" | "gemini-cli";

export const CLI_BINARIES: Record<CliKind, string> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
};

export const CLI_INSTALL_HINTS: Record<CliKind, string> = {
  "claude-cli": "npm i -g @anthropic-ai/claude-code  →  run `claude` once and sign in",
  "codex-cli": "npm i -g @openai/codex  →  run `codex login`",
  "gemini-cli": "npm i -g @google/gemini-cli  →  run `gemini` once and sign in with Google",
};

export async function findBinary(name: string): Promise<string | undefined> {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

/** Builds argv for one headless CLI call. Prompt is passed as a single argv entry (no shell). */
export function buildCliArgs(kind: CliKind, req: GenerateRequest, prompt: string): string[] {
  const model = req.model ? ["--model", req.model] : [];
  switch (kind) {
    case "claude-cli":
      return [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        req.mode === "edit" ? "acceptEdits" : "plan",
        ...model,
      ];
    case "codex-cli":
      return [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        req.mode === "edit" ? "workspace-write" : "read-only",
        "--cd",
        req.cwd,
        ...model,
        prompt,
      ];
    case "gemini-cli":
      return ["--approval-mode", req.mode === "edit" ? "auto_edit" : "plan", ...model, "-p", prompt];
  }
}

/** Extracts assistant text from one line of Claude Code `stream-json` output. */
export function parseClaudeStreamLine(line: string): { text?: string; result?: string; error?: string } {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return {};
  }
  if (ev.type === "assistant") {
    const content = (ev.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("");
    return text ? { text } : {};
  }
  if (ev.type === "result") {
    if (ev.is_error) return { error: String(ev.result ?? ev.subtype ?? "Claude Code failed") };
    return { result: typeof ev.result === "string" ? ev.result : "" };
  }
  return {};
}

const MAX_CAPTURE = 4_000_000;

export class CliProvider implements Provider {
  constructor(
    private conn: Connection,
    public readonly editsFiles = true,
  ) {}

  private get kind(): CliKind {
    return this.conn.kind as CliKind;
  }

  async generate(req: GenerateRequest, onDelta: DeltaHandler, signal: AbortSignal): Promise<string> {
    const bin = await findBinary(CLI_BINARIES[this.kind]);
    if (!bin) throw new ProviderError(`"${CLI_BINARIES[this.kind]}" not found. Install: ${CLI_INSTALL_HINTS[this.kind]}`);

    const prompt = `${req.system}\n\n---\n\n${req.prompt}`;
    const args = buildCliArgs(this.kind, { ...req, model: req.model || this.conn.defaultModel }, prompt);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: req.cwd,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      let buf = "";
      let finalResult: string | undefined;
      let cliError: string | undefined;

      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.kind !== "claude-cli") {
          if (out.length < MAX_CAPTURE) out += chunk;
          onDelta(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const parsed = parseClaudeStreamLine(line);
          if (parsed.text) {
            out += parsed.text + "\n";
            onDelta(parsed.text + "\n");
          }
          if (parsed.result !== undefined) finalResult = parsed.result;
          if (parsed.error) cliError = parsed.error;
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (err.length < 20_000) err += chunk;
      });
      child.on("error", (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(new ProviderError(`Failed to start ${CLI_BINARIES[this.kind]}: ${e.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(new ProviderError("Cancelled"));
        if (cliError) return reject(new ProviderError(cliError));
        if (code !== 0) {
          const detail = err.trim().split("\n").slice(-5).join("\n") || `exit code ${code}`;
          return reject(new ProviderError(`${CLI_BINARIES[this.kind]} failed: ${detail}`));
        }
        resolve(finalResult || out);
      });
    });
  }
}
