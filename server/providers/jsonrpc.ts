// JSON-RPC 2.0 over a child process's stdio (newline-delimited), shared by the ACP client and
// the Codex app-server client.
import { spawn, type ChildProcess } from "node:child_process";
import { ProviderError } from "./types.js";

export interface RpcLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const MAX_LINE = 8_000_000;

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };
interface RpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A child process that speaks JSON-RPC 2.0 over stdio, one message per line: ACP agents and
 * the Codex app-server both work this way. Requests from the child go to `onRequest`.
 */
export class JsonRpcChild {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buf = "";
  stderr = "";
  exited: Promise<number | null>;

  constructor(
    launch: RpcLaunch,
    cwd: string,
    env: Record<string, string>,
    private onRequest: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
    private onNotify: (method: string, params: Record<string, unknown>) => void,
  ) {
    this.child = spawn(launch.command, launch.args, {
      cwd,
      env: {
        ...process.env,
        ...(launch.env ?? {}),
        ...env,
        PWD: cwd,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.on("error", (e) => {
        this.stderr += `\n${e.message}`;
        resolve(-1);
      });
      this.child.on("close", (code) => resolve(code));
    });
    void this.exited.then((code) => {
      const err = new ProviderError(this.failure(code));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      if (this.stderr.length < 20_000) this.stderr += chunk;
    });
    this.child.stdin!.on("error", () => {});
  }

  failure(code: number | null): string {
    const tail = this.stderr.trim().split("\n").slice(-5).join("\n");
    return `agent exited${code === null ? "" : ` (code ${code})`}${tail ? `: ${tail}` : ""}`;
  }

  private read(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE) {
      this.buf = "";
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith("{")) continue; // agents sometimes log to stdout; skip non-JSON lines
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage) {
    if (msg.method && msg.id !== undefined) {
      // A request from the agent: answer it.
      this.onRequest(msg.method, msg.params ?? {}).then(
        (result) =>
          this.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: (result ?? null) as Json,
          }),
        (err: Error & { code?: number }) =>
          this.send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: err.code ?? -32603, message: err.message },
          }),
      );
    } else if (msg.method) {
      this.onNotify(msg.method, msg.params ?? {});
    } else if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new ProviderError(
          msg.error.message || `error ${msg.error.code}`,
        ) as ProviderError & { code?: number };
        e.code = msg.error.code;
        p.reject(e);
      } else p.resolve(msg.result);
    }
  }

  private send(msg: RpcMessage) {
    if (this.child.stdin?.writable)
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.send({
        jsonrpc: "2.0",
        id,
        method,
        params: params as Record<string, Json>,
      });
    });
  }

  notify(method: string, params: Record<string, unknown> | undefined) {
    this.send({
      jsonrpc: "2.0",
      method,
      params: params as Record<string, Json>,
    });
  }

  kill() {
    const pid = this.child.pid;
    if (process.platform === "win32" && pid)
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => this.child.kill());
    else this.child.kill("SIGTERM");
  }
}
