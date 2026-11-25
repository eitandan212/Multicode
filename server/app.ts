import { appendFile, mkdir } from "node:fs/promises";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConfigStore, HttpError, parseHeaders } from "./config.js";
import { DEFAULT_MODELS } from "./providers/api.js";
import {
  CLI_BINARIES,
  CLI_INSTALL_HINTS,
  findBinary,
  type CliKind,
} from "./providers/cli.js";
import type { ProviderFactory } from "./providers/registry.js";
import { RunManager } from "./runs.js";
import { autoCrew } from "./autocrew.js";
import { HarnessSync, ProjectMemory } from "./sync.js";
import { readGraph } from "./graph.js";
import { installAgent as installCli, SignIn } from "./signin.js";
import { checkConnection } from "./health.js";
import { CLI_SPECS } from "./providers/cli.js";
import { enabledPlugins, memoryGraphFile, PLUGINS } from "./plugins.js";
import { SKILL_PACKS } from "./skills.js";
import { parseTeam } from "./team.js";
import { installAgent, loadRegistry, registryView } from "./acp/registry.js";
import {
  AGENT_KINDS,
  API_KINDS,
  CLI_KINDS,
  type ExtensionsView,
  type ProviderKind,
} from "./shared.js";
import {
  linkProject,
  listProjects,
  setProjectEmoji,
  unlinkProject,
  validateProjectName,
  Workspace,
} from "./workspace.js";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface AppOptions {
  config: ConfigStore;
  projectsDir: string;
  /** Where run history is stored. Omit to keep runs in memory only. */
  runsDir?: string;
  /** Where project memory and sync state live. Omit to disable harness sync. */
  stateDir?: string;
  /** Origin the UI and previews are served from (for the browser plugin). */
  publicOrigin?: string;
  providerFactory: ProviderFactory;
  webDir?: string;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const param = (req: Request, key: string): string =>
  String(req.params[key] ?? "");

export function createApp(opts: AppOptions) {
  const { config, projectsDir } = opts;
  const memory = opts.stateDir
    ? new ProjectMemory(path.join(opts.stateDir, "memory"))
    : undefined;
  const sync =
    opts.stateDir && memory
      ? {
          harness: new HarnessSync(path.join(opts.stateDir, "sync"), memory),
          memory,
          dataDir: opts.stateDir,
          previewOrigin: opts.publicOrigin ?? "http://localhost:4317",
        }
      : undefined;
  const runs = new RunManager(
    config,
    projectsDir,
    opts.providerFactory,
    opts.runsDir,
    sync,
  );
  const app = express();
  app.disable("x-powered-by");

  // DNS-rebinding guard: only answer requests addressed to a loopback host.
  app.use((req, res, next) => {
    if (!LOOPBACK.test(req.headers.host ?? ""))
      return void res.status(403).send("Forbidden host");
    next();
  });

  app.use("/api", express.json({ limit: "2mb" }));
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
        manager: await runs.managerView(),
        settings: config.settings,
        projects: await listProjects(projectsDir),
        limits: runs.limitsView(),
        clis,
        defaultModels: DEFAULT_MODELS,
      });
    }),
  );

  api.post(
    "/connections",
    wrap(async (req, res) =>
      res.status(201).json(view(await config.upsertConnection(req.body ?? {}))),
    ),
  );
  api.patch(
    "/connections/:id",
    wrap(async (req, res) =>
      res.json(
        view(await config.upsertConnection(req.body ?? {}, param(req, "id"))),
      ),
    ),
  );
  api.delete(
    "/connections/:id",
    wrap(async (req, res) => {
      await config.deleteConnection(param(req, "id"));
      res.status(204).end();
    }),
  );
  const view = (c: { id: string }) => config.views().find((v) => v.id === c.id);

  // Agent Client Protocol registry: every ACP agent can join the crew (as in T3 Code).
  api.get(
    "/acp/agents",
    wrap(async (req, res) => {
      try {
        const agents = await loadRegistry({
          refresh: req.query.refresh === "1",
        });
        res.json({ agents: await registryView(agents) });
      } catch (err) {
        res.json({ agents: [], error: (err as Error).message.slice(0, 300) });
      }
    }),
  );
  const installing = new Map<string, Promise<unknown>>();
  api.post(
    "/acp/agents/:id/install",
    wrap(async (req, res) => {
      const id = param(req, "id");
      const agent = (await loadRegistry()).find((a) => a.id === id);
      if (!agent) throw new HttpError(404, "agent not found");
      try {
        if (!installing.has(id))
          installing.set(
            id,
            installAgent(agent).finally(() => installing.delete(id)),
          );
        await installing.get(id);
        res.json({ ok: true, agent: (await registryView([agent]))[0] });
      } catch (err) {
        res.status(502).json({ error: (err as Error).message.slice(0, 300) });
      }
    }),
  );

  const providerFor = (id: string) => {
    const conn = config.connection(id);
    if (!conn) throw new HttpError(404, "connection not found");
    return { conn, provider: opts.providerFactory(conn) };
  };

  api.post(
    "/connections/:id/test",
    wrap(async (req, res) => {
      const { conn, provider } = providerFor(param(req, "id"));
      const signal = AbortSignal.timeout(
        AGENT_KINDS.includes(conn.kind) ? 180_000 : 45_000,
      );
      try {
        const text = await provider.generate(
          {
            system: "You are a connectivity check.",
            prompt: "Reply with exactly: MultiCode connected",
            mode: "text",
            cwd: projectsDir,
            model:
              typeof req.body?.model === "string" ? req.body.model : undefined,
          },
          () => {},
          signal,
        );
        res.json({
          ok: true,
          message: text.trim().slice(0, 200) || "(empty reply)",
        });
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
        res.json({
          models: (
            await provider.listModels(AbortSignal.timeout(20_000))
          ).slice(0, 300),
        });
      } catch (err) {
        res.json({ models: [], error: (err as Error).message.slice(0, 300) });
      }
    }),
  );

  // Models of an API before it's saved: "Load models" in the add-connection form.
  api.post(
    "/models/preview",
    wrap(async (req, res) => {
      const kind = req.body?.kind;
      if (!API_KINDS.includes(kind)) throw new HttpError(400, "models can be listed for API connections");
      const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, "baseUrl must be http(s)");
      const provider = opts.providerFactory({
        id: "preview",
        kind,
        label: "preview",
        apiKey: typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined,
        baseUrl: baseUrl || undefined,
        headers: parseHeaders(req.body?.headers),
      });
      if (!provider.listModels) return void res.json({ models: [] });
      try {
        res.json({ models: (await provider.listModels(AbortSignal.timeout(20_000))).slice(0, 300) });
      } catch (err) {
        res.json({ models: [], error: (err as Error).message.slice(0, 300) });
      }
    }),
  );

  api.get("/sync", (_req, res) => res.json(config.syncView()));
  const extensionsView = (): ExtensionsView => {
    const ext = config.extensions;
    const on = new Set(
      enabledPlugins({
        enabled: ext.pluginsEnabled,
        disabled: ext.pluginsDisabled,
      }).map((p) => p.id),
    );
    return {
      plugins: PLUGINS.map(
        ({ id, name, category, description, risk, source, optionalEnv }) => ({
          id,
          name,
          category,
          description,
          risk,
          source,
          optionalEnv,
          enabled: on.has(id),
        }),
      ),
      packs: SKILL_PACKS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        skills: p.skills.map((s) => ({
          name: s.name,
          description: s.description,
        })),
        mode: ext.packModes[p.id] ?? "auto",
      })),
      browserAnyWebsite: ext.browserAnyWebsite,
    };
  };
  api.get("/extensions", (_req, res) => res.json(extensionsView()));
  api.put(
    "/extensions",
    wrap(async (req, res) => {
      await config.setExtensions(req.body ?? {});
      res.json(extensionsView());
    }),
  );
  api.put(
    "/sync",
    wrap(async (req, res) => res.json(await config.setSync(req.body ?? {}))),
  );
  api.post(
    "/projects/:name/sync",
    wrap(async (req, res) =>
      res.json(await runs.syncProject(validateProjectName(param(req, "name")))),
    ),
  );
  api.post(
    "/runs/:id/undo",
    wrap(async (req, res) =>
      res.json(await runs.undo(param(req, "id"), req.body?.force === true)),
    ),
  );
  api.put(
    "/crew",
    wrap(async (req, res) => res.json(await config.setCrew(req.body))),
  );
  api.put(
    "/settings",
    wrap(async (req, res) =>
      res.json(await config.setSettings(req.body ?? {})),
    ),
  );

  api.get(
    "/projects",
    wrap(async (_req, res) => res.json(await listProjects(projectsDir))),
  );
  // One-click agent setup: install, sign in, and who you're signed in as.
  const signIn = new SignIn();
  // A connection's health: free and fast (no model is asked anything).
  api.get(
    "/connections/:id/check",
    wrap(async (req, res) => {
      const { conn, provider } = providerFor(param(req, "id"));
      res.json(await checkConnection(conn, provider, signIn));
    }),
  );
  api.get(
    "/agents/:kind/access",
    wrap(async (req, res) => res.json(await signIn.access(param(req, "kind")))),
  );
  api.post(
    "/agents/:kind/install",
    wrap(async (req, res) => {
      const kind = param(req, "kind");
      if (kind !== "antigravity" && !Object.hasOwn(CLI_SPECS, kind)) throw new HttpError(400, "unknown agent");
      res.json(await installCli(kind as keyof typeof CLI_SPECS | "antigravity"));
    }),
  );
  api.post(
    "/agents/:kind/signin",
    wrap(async (req, res) => res.status(201).json(await signIn.start(param(req, "kind")))),
  );
  api.get("/signin/:id", wrap(async (req, res) => res.json(signIn.view(param(req, "id")))));
  api.post(
    "/signin/:id/code",
    wrap(async (req, res) => {
      signIn.code(param(req, "id"), req.body?.code);
      res.status(204).end();
    }),
  );
  api.post(
    "/signin/:id/cancel",
    wrap(async (req, res) => {
      signIn.cancel(param(req, "id"));
      res.status(204).end();
    }),
  );

  // The project's memory graph (what the crew and the memory plugin remember).
  api.get(
    "/projects/:name/memory",
    wrap(async (req, res) => {
      const name = validateProjectName(param(req, "name"));
      res.json(
        opts.stateDir
          ? await readGraph(memoryGraphFile(opts.stateDir, name))
          : { entities: [], relations: [] },
      );
    }),
  );
  // Open an existing folder on this computer as a project.
  api.post(
    "/projects/open",
    wrap(async (req, res) => {
      res.status(201).json({ name: await linkProject(projectsDir, req.body?.path) });
    }),
  );
  api.put(
    "/projects/:name/emoji",
    wrap(async (req, res) => {
      await setProjectEmoji(projectsDir, param(req, "name"), req.body?.emoji ?? null);
      res.status(204).end();
    }),
  );
  api.post(
    "/projects/:name/unlink",
    wrap(async (req, res) => {
      await unlinkProject(projectsDir, validateProjectName(param(req, "name")));
      res.status(204).end();
    }),
  );
  api.post(
    "/projects",
    wrap(async (req, res) => {
      const ws = await Workspace.open(
        projectsDir,
        validateProjectName(req.body?.name),
      );
      res.status(201).json({ name: path.basename(ws.root) });
    }),
  );
  api.get(
    "/projects/:name/files",
    wrap(async (req, res) =>
      res.json(
        await (await Workspace.open(projectsDir, param(req, "name"))).list(),
      ),
    ),
  );
  api.get(
    "/projects/:name/file",
    wrap(async (req, res) => {
      const ws = await Workspace.open(projectsDir, param(req, "name"));
      res.json({
        path: req.query.path,
        content: await ws.read(String(req.query.path ?? "")),
      });
    }),
  );
  // IDE: save and delete files. Refused while a crew works on the same project.
  const editable = async (name: string, rel: unknown) => {
    const project = validateProjectName(name);
    if (runs.isWorking(project))
      throw new HttpError(
        409,
        "the crew is working on this project; save again when it's done",
      );
    if (typeof rel !== "string" || !rel.trim())
      throw new HttpError(400, "path is required");
    return { ws: await Workspace.open(projectsDir, project), rel: rel.trim() };
  };
  api.put(
    "/projects/:name/file",
    wrap(async (req, res) => {
      const { ws, rel } = await editable(param(req, "name"), req.body?.path);
      if (typeof req.body?.content !== "string")
        throw new HttpError(400, "content must be text");
      await ws.write(rel, req.body.content);
      res.json({ ok: true, path: rel });
    }),
  );
  api.delete(
    "/projects/:name/file",
    wrap(async (req, res) => {
      const { ws, rel } = await editable(param(req, "name"), req.query.path);
      await ws.remove(rel);
      res.status(204).end();
    }),
  );
  api.get("/runs", (_req, res) => res.json(runs.list()));
  api.get("/projects/:name/runs", (req, res) =>
    res.json(runs.list(validateProjectName(param(req, "name")))),
  );
  api.post(
    "/projects/:name/runs",
    wrap(async (req, res) =>
      res.status(201).json(
        await runs.start(
          validateProjectName(param(req, "name")),
          req.body?.prompt,
          req.body?.mode ?? "build",
          parseTeam(req.body?.team, (id) => config.connection(id)),
          req.body?.sleep === true,
        ),
      ),
    ),
  );
  api.post(
    "/runs/:id/apply",
    wrap(async (req, res) =>
      res.json(
        await runs.apply(
          param(req, "id"),
          typeof req.body?.variant === "string" ? req.body.variant : undefined,
          req.body?.force === true,
        ),
      ),
    ),
  );
  api.post(
    "/runs/:id/discard",
    wrap(async (req, res) => {
      await runs.discard(param(req, "id"));
      res.json({ ok: true });
    }),
  );
  api.post("/connections/:id/limit-reset", (req, res) => {
    runs.clearLimit(param(req, "id"));
    res.json({ ok: true });
  });
  api.post(
    "/connections/:id/auto-crew",
    wrap(async (req, res) => {
      const conn = config.connection(param(req, "id"));
      if (!conn) throw new HttpError(404, "connection not found");
      if (conn.kind !== "openai-compatible")
        throw new HttpError(
          400,
          "Auto crew works with a multi-model key such as OpenRouter.",
        );
      try {
        const crew = await config.setCrew(await autoCrew(conn));
        res.json(crew);
      } catch (err) {
        throw err instanceof HttpError
          ? err
          : new HttpError(502, (err as Error).message);
      }
    }),
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
  api.post(
    "/runs/:id/approvals/:approval",
    wrap(async (req, res) => {
      runs.approve(
        param(req, "id"),
        param(req, "approval"),
        req.body?.allow === true,
        req.body?.always === true,
      );
      res.status(204).end();
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
    res.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    );
    res.setHeader("Cache-Control", "no-store");
    void Workspace.rootOf(projectsDir, name).then((root) =>
      express.static(root, {
        dotfiles: "deny",
        index: ["index.html"],
      })(req, res, next),
    next);
  });

  // Sandboxes and design variants, served like the project preview (opaque, sandboxed origin).
  app.use("/preview-sandbox/:run/:name", (req, res, next) => {
    let root: string;
    try {
      root = runs.sandboxRoot(param(req, "run"), param(req, "name"));
    } catch {
      return void res.status(404).end();
    }
    res.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    );
    res.setHeader("Cache-Control", "no-store");
    express.static(root, { dotfiles: "deny", index: ["index.html"] })(
      req,
      res,
      next,
    );
  });

  if (opts.webDir && existsSync(opts.webDir)) {
    app.use(express.static(opts.webDir));
    app.get(/^(?!\/api|\/preview).*/, (_req, res) =>
      res.sendFile(path.join(opts.webDir!, "index.html")),
    );
  }

  app.use("/api", (_req: Request, res: Response) =>
    res.status(404).json({ error: "not found" }),
  );
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof HttpError
        ? err.status
        : ((err as { status?: number }).status ?? 500);
    if (status >= 500) {
      console.error(err);
      // Kept in the data folder (logs/errors.log), so a problem on someone's computer can be read.
      if (opts.stateDir)
        void mkdir(path.join(opts.stateDir, "logs"), { recursive: true })
          .then(() =>
            appendFile(
              path.join(opts.stateDir!, "logs", "errors.log"),
              `${new Date().toISOString()} ${_req.method} ${_req.path}\n${err.stack ?? err.message}\n\n`,
            ),
          )
          .catch(() => {});
    }
    // MultiCode runs on your own computer: say what went wrong instead of a bare "Internal error".
    res.status(status).json({
      error:
        status >= 500
          ? `Something went wrong: ${(err.message || "unknown error").slice(0, 400)}`
          : err.message,
    });
  });

  return { app, runs };
}

export type { ProviderKind };
