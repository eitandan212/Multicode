import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Connection } from "../config.js";
import type { ProviderKind } from "../shared.js";
import { codexMcpArgs } from "../sync.js";
import {
  ProviderError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

export type CliKind = Extract<ProviderKind, `${string}-cli`>;

type OutputParser = "text" | "claude-stream" | "opencode-json";

interface CliSpec {
  binary: string;
  install: string;
  output: OutputParser;
  /**
   * argv for one headless call. The prompt is a single argv entry; no shell is involved.
   * `major` is the CLI's major version when `versioned` is set (0 if it couldn't be read).
   */
  args(req: GenerateRequest, prompt: string, major: number): string[];
  /** The CLI's flags differ between major versions: read `--version` once before calling. */
  versioned?: boolean;
  /** Extra environment for the child process (permission hardening). */
  env?(req: GenerateRequest): Record<string, string>;
  /** argv that prints one model id per line, when the CLI supports listing. */
  listModels?: string[];
}

const modelArg = (req: GenerateRequest, flag = "--model") =>
  req.model ? [flag, req.model] : [];

/**
 * Agent CLIs MultiCode can drive. Every entry runs edit-only when building and read-only
 * when planning or reviewing. None of them is ever given a "skip all permissions" flag.
 */
export const CLI_SPECS: Record<CliKind, CliSpec> = {
  "claude-cli": {
    binary: "claude",
    install:
      "npm i -g @anthropic-ai/claude-code  →  run `claude` once and sign in",
    output: "claude-stream",
    args: (req, prompt) => [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      req.mode === "edit" ? "acceptEdits" : "plan",
      ...modelArg(req),
    ],
  },
  "codex-cli": {
    binary: "codex",
    install: "npm i -g @openai/codex  →  run `codex login`",
    output: "text",
    args: (req, prompt) => [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      req.mode === "edit" ? "workspace-write" : "read-only",
      "--cd",
      req.cwd,
      ...modelArg(req),
      ...codexMcpArgs(req.mcpServers ?? []),
      prompt,
    ],
  },
  "gemini-cli": {
    binary: "gemini",
    install:
      "npm i -g @google/gemini-cli  →  run `gemini` once and sign in with Google",
    output: "text",
    args: (req, prompt) => [
      "--approval-mode",
      req.mode === "edit" ? "auto_edit" : "plan",
      ...modelArg(req),
      "-p",
      prompt,
    ],
  },
  // Open-source agents
  "opencode-cli": {
    binary: "opencode",
    install:
      "npm i -g opencode-ai  →  free models work right away; run `opencode auth login` for your own accounts",
    output: "opencode-json",
    versioned: true,
    // OpenCode 2 dropped --dir (it follows the working folder), shares one background service
    // unless --standalone, and asks before editing unless --auto (shell and web stay denied below).
    args: (req, prompt, major) =>
      major >= 2
        ? [
            "run",
            "--format",
            "json",
            "--standalone",
            "--agent",
            req.mode === "edit" ? "build" : "plan",
            ...(req.mode === "edit" ? ["--auto"] : []),
            ...modelArg(req, "-m"),
            prompt,
          ]
        : [
            "run",
            "--format",
            "json",
            "--dir",
            req.cwd,
            "--agent",
            req.mode === "edit" ? "build" : "plan",
            ...modelArg(req, "-m"),
            prompt,
          ],
    // Inline config: shell and web tools removed entirely, so the agent can only read and edit files.
    env: () => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { bash: "deny", webfetch: "deny" },
      }),
    }),
    listModels: ["models"],
  },
  "qwen-cli": {
    binary: "qwen",
    install:
      "npm i -g @qwen-code/qwen-code  →  run `qwen` once and sign in (free Qwen account works)",
    output: "text",
    args: (req, prompt) => [
      "--approval-mode",
      req.mode === "edit" ? "auto-edit" : "plan",
      "-o",
      "text",
      ...modelArg(req, "-m"),
      prompt,
    ],
  },
};

export const CLI_BINARIES = Object.fromEntries(
  Object.entries(CLI_SPECS).map(([k, s]) => [k, s.binary]),
) as Record<CliKind, string>;
export const CLI_INSTALL_HINTS = Object.fromEntries(
  Object.entries(CLI_SPECS).map(([k, s]) => [k, s.install]),
) as Record<CliKind, string>;

const majors = new Map<string, Promise<number>>();

/** The major version a CLI reports for `--version` ("v2.4.1" -> 2); 0 when unknown. Cached. */
export function cliMajor(launch: Launch): Promise<number> {
  const key = [launch.command, ...launch.prefix].join(" ");
  let p = majors.get(key);
  if (!p) {
    p = new Promise<number>((resolve) => {
      execFile(
        launch.command,
        [...launch.prefix, "--version"],
        {
          timeout: 15_000,
          env: { ...process.env, ...launch.env, NO_COLOR: "1" },
          windowsHide: true,
        },
        (err, stdout) => {
          const m = /(\d+)\.\d+/.exec(String(stdout ?? ""));
          resolve(err || !m ? 0 : Number(m[1]));
        },
      );
    });
    majors.set(key, p);
  }
  return p;
}

export async function findBinary(name: string): Promise<string | undefined> {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";")
      : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  // Where `npm i -g` puts launchers on Windows, even when PATH doesn't list it yet.
  if (process.platform === "win32" && process.env.APPDATA)
    dirs.push(path.join(process.env.APPDATA, "npm"));
  for (const dir of dirs) {
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

export interface Launch {
  command: string;
  /** Arguments that go before the CLI's own arguments (e.g. the script for node). */
  prefix: string[];
  env?: Record<string, string>;
}

/**
 * How to start a CLI without a shell. On Windows, npm installs CLIs as `.cmd` shims, which
 * Node refuses to spawn without `cmd.exe` (and passing a prompt through cmd.exe would be an
 * injection risk). So we read the shim, find the JavaScript entry it points to, and run that
 * with Node directly.
 */
export async function resolveLaunch(bin: string): Promise<Launch> {
  if (!/\.(cmd|bat)$/i.test(bin)) return { command: bin, prefix: [] };
  const shim = await readFile(bin, "utf8");
  let target = parseCmdShim(shim);
  // npm.cmd / npx.cmd whose format changed: npm's scripts sit next to them in every Node install.
  const npmTool = /^(npm|npx)\.cmd$/i.exec(path.basename(bin))?.[1]?.toLowerCase();
  if (!target && npmTool) {
    const guess = `node_modules/npm/bin/${npmTool}-cli.js`;
    if (await access(path.resolve(path.dirname(bin), guess)).then(() => true, () => false)) target = guess;
  }
  if (!target)
    throw new ProviderError(
      `Can't start ${path.basename(bin)}: it isn't a standard npm launcher. Reinstall it with npm.`,
    );
  const script = path.resolve(path.dirname(bin), target);
  const node = await findBinary("node");
  if (node) return { command: node, prefix: [script] };
  // No Node on PATH: inside the desktop app, Electron's own runtime can run the script.
  return {
    command: process.execPath,
    prefix: [script],
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
  };
}

/** The script path inside an npm `.cmd` shim, relative to the shim's folder. */
export function parseCmdShim(shim: string): string | undefined {
  // npm's own npm.cmd / npx.cmd (shipped with Node): SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
  const npm = /SET\s+"NP[MX]_CLI_JS=%~?dp0%?\\([^"\r\n]+?\.(?:c?js|mjs))"/i.exec(shim);
  if (npm) return npm[1]!.replace(/\\/g, "/");
  // cmd-shim launchers (every `npm i -g` tool): "%dp0%\node_modules\pkg\cli.js"
  const m = /"%(?:~?dp0%?|dp0%)\\([^"]+?\.(?:c?js|mjs))"/i.exec(shim);
  return m ? m[1]!.replace(/\\/g, "/") : undefined;
}

/** Builds argv for one headless CLI call. */
export function buildCliArgs(
  kind: CliKind,
  req: GenerateRequest,
  prompt: string,
  major = 1,
): string[] {
  return CLI_SPECS[kind].args(req, prompt, major);
}

export interface ParsedLine {
  text?: string;
  result?: string;
  error?: string;
  usage?: { input: number; output: number; cached?: number; costUsd?: number };
}

/** Extracts assistant text from one line of Claude Code `stream-json` output. */
export function parseClaudeStreamLine(line: string): ParsedLine {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return {};
  }
  if (ev.type === "assistant") {
    const content =
      (
        ev.message as
          | { content?: { type: string; text?: string }[] }
          | undefined
      )?.content ?? [];
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("");
    return text ? { text } : {};
  }
  if (ev.type === "result") {
    if (ev.is_error)
      return { error: String(ev.result ?? ev.subtype ?? "Claude Code failed") };
    const u = ev.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    return {
      result: typeof ev.result === "string" ? ev.result : "",
      ...(u
        ? {
            usage: {
              input: u.input_tokens ?? 0,
              cached: u.cache_read_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              costUsd:
                typeof ev.total_cost_usd === "number"
                  ? ev.total_cost_usd
                  : undefined,
            },
          }
        : {}),
    };
  }
  return {};
}

/** Extracts text, tool activity and errors from one line of OpenCode `--format json` output. */
export function parseOpenCodeLine(line: string): ParsedLine {
  let ev: {
    type?: string;
    part?: Record<string, unknown>;
    error?: { name?: string; data?: { message?: string } };
  };
  try {
    ev = JSON.parse(line);
  } catch {
    return {};
  }
  if (ev.type === "text" && typeof ev.part?.text === "string")
    return { text: ev.part.text };
  if (ev.type === "tool_use" && ev.part) {
    const state = ev.part.state as
      | { status?: string; title?: string; input?: { filePath?: string } }
      | undefined;
    const target = state?.input?.filePath
      ? path.basename(state.input.filePath)
      : (state?.title ?? "");
    return { text: `▸ ${String(ev.part.tool ?? "tool")} ${target}`.trimEnd() };
  }
  if (ev.type === "error")
    return {
      error: ev.error?.data?.message ?? ev.error?.name ?? "OpenCode failed",
    };
  if (ev.type === "step_finish" && ev.part) {
    const t = ev.part.tokens as
      | {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number };
        }
      | undefined;
    if (t)
      return {
        usage: {
          input: t.input ?? 0,
          cached: t.cache?.read ?? 0,
          output: (t.output ?? 0) + (t.reasoning ?? 0),
          costUsd: typeof ev.part.cost === "number" ? ev.part.cost : undefined,
        },
      };
  }
  return {};
}

const MAX_CAPTURE = 4_000_000;

export class CliProvider implements Provider {
  readonly editsFiles = true;

  constructor(private conn: Connection) {}

  private get spec(): CliSpec {
    return CLI_SPECS[this.conn.kind as CliKind];
  }

  private async binary(): Promise<string> {
    const bin = await findBinary(this.spec.binary);
    if (!bin)
      throw new ProviderError(
        `"${this.spec.binary}" not found. Install: ${this.spec.install}`,
      );
    return bin;
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    if (!this.spec.listModels) return [];
    const launch = await resolveLaunch(await this.binary());
    return new Promise((resolve, reject) => {
      execFile(
        launch.command,
        [...launch.prefix, ...this.spec.listModels!],
        {
          signal,
          maxBuffer: 4_000_000,
          env: { ...process.env, ...launch.env, NO_COLOR: "1" },
        },
        (err, stdout) => {
          if (err) return reject(new ProviderError(err.message));
          resolve(
            stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => /^[\w.-]+\/[\w.:@/-]+$/.test(l)),
          );
        },
      );
    });
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    const launch = await resolveLaunch(await this.binary());
    const spec = this.spec;
    const major = spec.versioned ? await cliMajor(launch) : 0;
    const call = { ...req, model: req.model || this.conn.defaultModel };
    const prompt = `${req.system}\n\n---\n\n${req.prompt}`;
    const parse =
      spec.output === "claude-stream"
        ? parseClaudeStreamLine
        : spec.output === "opencode-json"
          ? parseOpenCodeLine
          : null;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        launch.command,
        [...launch.prefix, ...spec.args(call, prompt, major)],
        {
          cwd: req.cwd,
          // PWD too: some agents (OpenCode) resolve their project from it rather than the real cwd.
          env: {
            ...process.env,
            ...(launch.env ?? {}),
            ...(req.env ?? {}),
            PWD: req.cwd,
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            ...(spec.env?.(call) ?? {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let out = "";
      let answer = "";
      let err = "";
      let buf = "";
      let finalResult: string | undefined;
      let cliError: string | undefined;

      // On Windows, kill the whole tree: npm launchers start the real CLI as a child process.
      const onAbort = () => {
        if (process.platform === "win32" && child.pid)
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          }).on("error", () => child.kill());
        else child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!parse) {
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
          const parsed = parse(line);
          if (parsed.text) {
            if (out.length < MAX_CAPTURE) out += parsed.text + "\n";
            if (!parsed.text.startsWith("▸ ")) answer += parsed.text + "\n";
            onDelta(parsed.text + "\n");
          }
          if (parsed.result !== undefined) finalResult = parsed.result;
          if (parsed.usage) req.onUsage?.(parsed.usage);
          if (parsed.error) cliError = parsed.error;
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (err.length < 20_000) err += chunk;
      });
      child.on("error", (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(
          new ProviderError(`Failed to start ${spec.binary}: ${e.message}`),
        );
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(new ProviderError("Cancelled"));
        if (cliError) return reject(new ProviderError(cliError));
        if (code !== 0) {
          const detail =
            err.trim().split("\n").slice(-5).join("\n") || `exit code ${code}`;
          return reject(new ProviderError(`${spec.binary} failed: ${detail}`));
        }
        // Prefer the agent's final answer; tool-activity lines are for the live view only.
        resolve(finalResult || answer || out);
      });
    });
  }
}
