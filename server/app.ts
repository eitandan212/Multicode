import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConfigStore, HttpError } from "./config.js";
import { DEFAULT_MODELS } from "./providers/api.js";
import { CLI_BINARIES, CLI_INSTALL_HINTS, findBinary, type CliKind } from "./providers/cli.js";
import type { ProviderFactory } from "./providers/registry.js";
import { RunManager } from "./runs.js";
import { CLI_KINDS, type ProviderKind } from "./shared.js";
import { listProjects, validateProjectName, Workspace } from "./workspace.js";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface AppOptions {
  config: ConfigStore;
  projectsDir: string;
  /** Where run history is stored. Omit to keep runs in memory only. */
  runsDir?: string;
  providerFactory: ProviderFactory;
  webDir?: string;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const param = (req: Request, key: string): string => String(req.params[key] ?? "");

export function createApp(opts: AppOptions) {
  const { config, projectsDir } = opts;
  const runs = new RunManager(config, projectsDir, opts.providerFactory, opts.runsDir);
  const app = express();
  app.disable("x-powered-by");

  // DNS-rebinding guard: only answer requests addressed to a loopback host.
  app.use((req, res, next) => {
    if (!LOOPBACK.test(req.headers.host ?? "")) return void res.status(403).send("Forbidden host");
    next();
  });

  app.use("/api", express.json({ limit: "1mb" }));
  // CSRF guard: a custom header forces a CORS preflight, which we never approve.
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.headers["x-multicode"] !== "1")
      return void res.status(403).json({ error: "missing X-MultiCode header" });
    next();
  });

  const api = express.Router();

  api.get(
    "/state",
    wrap(async (_req, res) => {
      const clis = await Promise.all(
        CLI_KINDS.map(async (kind) => ({
          kind,
          binary: CLI_BINARIES[kind as CliKind],
          installed: Boolean(await findBinary(CLI_BINARIES[kind as CliKind])),
          hint: CLI_INSTALL_HINTS[kind as CliKind],
        })),
      );
      res.json({
        connections: config.views(),
        crew: config.crew,
        effectiveCrew: runs.effectiveCrew(),
        settings: config.settings,
        projects: await listProjects(projectsDir),
        clis,
        defaultModels: DEFAULT_MODELS,
      });
    }),
  );

  api.post("/connections", wrap(async (req, res) => res.status(201).json(view(await config.upsertConnection(req.body ?? {})))));
  api.patch(
    "/connections/:id",
    wrap(async (req, res) => res.json(view(await config.upsertConnection(req.body ?? {}, param(req, "id"))))),
  );
  api.delete(
    "/connections/:id",
    wrap(async (req, res) => {
      await config.deleteConnection(param(req, "id"));
      res.status(204).end();
    }),
  );
  const view = (c: { id: string }) => config.views().find((v) => v.id === c.id);

  const providerFor = (id: string) => {
    const conn = config.connection(id);
    if (!conn) throw new HttpError(404, "connection not found");
    return { conn, provider: opts.providerFactory(conn) };
  };

  api.post(
    "/connections/:id/test",
    wrap(async (req, res) => {
      const { conn, provider } = providerFor(param(req, "id"));
      const signal = AbortSignal.timeout(CLI_KINDS.includes(conn.kind) ? 120_000 : 45_000);
      try {
        const text = await provider.generate(
          {
            system: "You are a connectivity check.",
            prompt: "Reply with exactly: MultiCode connected",
            mode: "text",
            cwd: projectsDir,
            model: typeof req.body?.model === "string" ? req.body.model : undefined,
          },
          () => {},
          signal,
        );
        res.json({ ok: true, message: text.trim().slice(0, 200) || "(empty reply)" });
      } catch (err) {
        res.json({ ok: false, message: (err as Error).message.slice(0, 500) });
      }
    }),
  );

  api.get(
    "/connections/:id/models",
    wrap(async (req, res) => {
      const { provider } = providerFor(param(req, "id"));
      if (!provider.listModels) return void res.json({ models: [] });
      try {
        res.json({ models: (await provider.listModels(AbortSignal.timeout(20_000))).slice(0, 300) });
      } catch (err) {
        res.json({ models: [], error: (err as Error).message.slice(0, 300) });
      }
    }),
  );

  api.put("/crew", wrap(async (req, res) => res.json(await config.setCrew(req.body))));
  api.put("/settings", wrap(async (req, res) => res.json(await config.setSettings(req.body ?? {}))));

  api.get("/projects", wrap(async (_req, res) => res.json(await listProjects(projectsDir))));
  api.post(
    "/projects",
    wrap(async (req, res) => {
      const ws = await Workspace.open(projectsDir, validateProjectName(req.body?.name));
      res.status(201).json({ name: path.basename(ws.root) });
    }),
  );
  api.get(
    "/projects/:name/files",
    wrap(async (req, res) => res.json(await (await Workspace.open(projectsDir, param(req, "name"))).list())),
  );
  api.get(
    "/projects/:name/file",
    wrap(async (req, res) => {
      const ws = await Workspace.open(projectsDir, param(req, "name"));
      res.json({ path: req.query.path, content: await ws.read(String(req.query.path ?? "")) });
    }),
  );
  api.get("/runs", (_req, res) => res.json(runs.list()));
  api.get("/projects/:name/runs", (req, res) => res.json(runs.list(validateProjectName(param(req, "name")))));
  api.post(
    "/projects/:name/runs",
    wrap(async (req, res) => res.status(201).json(await runs.start(validateProjectName(param(req, "name")), req.body?.prompt))),
  );

  api.get(
    "/runs/:id/events",
    wrap(async (req, res) => {
      const run = runs.get(param(req, "id"));
      // Read history first; no await may sit between replaying it and subscribing.
      const history = await runs.events(run.id);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of history) send(e);
      const unsubscribe = runs.subscribe(run.id, send);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
    }),
  );
  api.post("/runs/:id/cancel", (req, res) => {
    runs.cancel(param(req, "id"));
    res.status(202).json({ ok: true });
  });

  app.use("/api", api);

  // Live preview of a project. Sandboxed: the page runs at an opaque origin, so generated
  // code cannot call the MultiCode API or read its storage.
  app.use("/preview/:name", (req, res, next) => {
    let name: string;
    try {
      name = validateProjectName(param(req, "name"));
    } catch {
      return void res.status(404).end();
    }
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads");
    res.setHeader("Cache-Control", "no-store");
    express.static(path.join(projectsDir, name), { dotfiles: "deny", index: ["index.html"] })(req, res, next);
  });

  if (opts.webDir && existsSync(opts.webDir)) {
    app.use(express.static(opts.webDir));
    app.get(/^(?!\/api|\/preview).*/, (_req, res) => res.sendFile(path.join(opts.webDir!, "index.html")));
  }

  app.use("/api", (_req: Request, res: Response) => res.status(404).json({ error: "not found" }));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Internal error" : err.message });
  });

  return { app, runs };
}

export type { ProviderKind };
