import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { IMAGE_TYPES, RunManager } from "./runs.js";
import { autoCrew } from "./autocrew.js";
import { HarnessSync, ProjectMemory } from "./sync.js";
import { readGraph } from "./graph.js";
import { installAgent as installCli, SignIn } from "./signin.js";
import { checkConnection } from "./health.js";
import { SESSION_COOKIE, viewOf as userView, type Auth, type User } from "./auth.js";
import { checkCaching } from "./cacheCheck.js";
import { listCommands } from "./commands.js";
import { CustomSkills } from "./customSkills.js";
import { discoverMcp, importPlan, viewOf } from "./mcpImport.js";
import { cloneUrl, gitBranches, gitCheckout, gitClone, gitCommit, gitInit, gitPull, gitPush, gitStatus, repoName } from "./git.js";
import { accountUsage, USAGE_KINDS } from "./usage.js";
import { readFileSync } from "node:fs";

/** The app's version, from package.json (next to dist/ in the app and in development). */
const APP_VERSION: string = (() => {
  for (const p of ["../../package.json", "../package.json"])
    try {
      return (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { version: string }).version;
    } catch {
      /* try the next place */
    }
  return "dev";
})();
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
  setProjectCheck,
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
  /** Accounts: once one exists, every request needs a signed-in session. */
  auth?: Auth;
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
  // Your own skills live in the data folder (custom-skills/<name>/SKILL.md).
  const customSkills = new CustomSkills(path.join(opts.stateDir ?? path.join(projectsDir, ".."), "custom-skills"));
  runs.customSkills = customSkills;
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

  // ---- Accounts ----
  const auth = opts.auth;
  const cookieToken = (req: Request): string | undefined =>
    /(?:^|;\s*)mc_session=([\w-]{20,200})/.exec(req.headers.cookie ?? "")?.[1];
  const setSession = (res: Response, token: string) =>
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
  const OPEN = /^\/auth\/(status|login|setup|google\/(start|callback|poll))$/;
  // Every API call and every project preview needs a session once there is an account.
  const guard = (req: Request, res: Response, next: () => void) => {
    if (!auth?.required) return next();
    const user = auth.userFor(cookieToken(req));
    if (!user) return void res.status(401).json({ error: "Sign in to MultiCode", signIn: true });
    (req as Request & { user?: User }).user = user;
    next();
  };
  app.use("/api", (req, res, next) => (OPEN.test(req.path) ? next() : guard(req, res, next)));
  app.use(["/preview", "/preview-sandbox"], guard);
  const userOf = (req: Request) => (req as Request & { user?: User }).user;

  const api = express.Router();

  api.get("/auth/status", (req, res) => {
    const user = auth?.userFor(cookieToken(req));
    res.json({
      required: Boolean(auth?.required),
      setup: Boolean(auth) && !auth!.required,
      google: Boolean(auth?.googleReady),
      user: user ? userView(user) : null,
    });
  });
  api.post(
    "/auth/setup",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      if (auth.required) throw new HttpError(409, "MultiCode already has an owner: sign in instead");
      const user = await auth.addUser(req.body ?? {});
      const { token } = await auth.signIn(user.email, req.body?.password);
      setSession(res, token);
      res.status(201).json(userView(user));
    }),
  );
  api.post(
    "/auth/login",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      const { token, user } = await auth.signIn(req.body?.email, req.body?.password);
      setSession(res, token);
      res.json(userView(user));
    }),
  );
  api.post(
    "/auth/logout",
    wrap(async (req, res) => {
      await auth?.signOut(cookieToken(req));
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      res.status(204).end();
    }),
  );
  api.post(
    "/auth/password",
    wrap(async (req, res) => {
      const user = userOf(req);
      if (!auth || !user) throw new HttpError(401, "Sign in first");
      await auth.changePassword(user, req.body?.current, req.body?.next);
      const { token } = await auth.signIn(user.email, req.body?.next);
      setSession(res, token);
      res.status(204).end();
    }),
  );
  api.get("/auth/users", (req, res) => res.json(auth?.users() ?? []));
  api.post(
    "/auth/users",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      res.status(201).json(userView(await auth.addUser(req.body ?? {}, userOf(req))));
    }),
  );
  api.delete(
    "/auth/users/:id",
    wrap(async (req, res) => {
      const user = userOf(req);
      if (!auth || !user) throw new HttpError(401, "Sign in first");
      await auth.removeUser(param(req, "id"), user);
      res.status(204).end();
    }),
  );
  api.put(
    "/auth/google",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      await auth.setGoogle(req.body ?? {}, userOf(req));
      res.status(204).end();
    }),
  );
  api.post(
    "/auth/google/start",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      res.json(auth.googleStart(`http://${req.headers.host}`));
    }),
  );
  api.get(
    "/auth/google/callback",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      await auth.googleCallback(req.query.state, req.query.code);
      res
        .type("html")
        .send(
          '<!doctype html><meta charset="utf-8"><title>MultiCode</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0"><p>Done. You can close this tab and go back to MultiCode.</p></body>',
        );
    }),
  );
  api.post(
    "/auth/google/poll",
    wrap(async (req, res) => {
      if (!auth) throw new HttpError(404, "Accounts aren't available here");
      const r = await auth.googlePoll(req.body?.state);
      if (r.done && "token" in r) {
        setSession(res, r.token);
        return void res.json({ done: true, user: userView(r.user) });
      }
      res.json(r);
    }),
  );

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
  // Your own "/" commands from Claude Code (.claude/commands) and Codex (~/.codex/prompts).
  api.get(
    "/projects/:name/commands",
    wrap(async (req, res) => {
      const ws = await Workspace.open(projectsDir, validateProjectName(param(req, "name")));
      res.json(await listCommands(ws.root));
    }),
  );
  // Your own skills: list, write, delete, install from GitHub.
  api.get("/skills/custom", wrap(async (_req, res) => res.json(await customSkills.list())));
  api.put("/skills/custom/:name", wrap(async (req, res) => res.json(await customSkills.save({ ...(req.body ?? {}), name: param(req, "name") }))));
  api.delete(
    "/skills/custom/:name",
    wrap(async (req, res) => {
      await customSkills.remove(param(req, "name"));
      res.status(204).end();
    }),
  );
  api.post("/skills/custom/install", wrap(async (req, res) => res.status(201).json(await customSkills.install(req.body?.url))));
  // MCP servers already set up in Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, Windsurf.
  api.get(
    "/mcp/discover",
    wrap(async (_req, res) => res.json(viewOf(await discoverMcp(), config.syncView().mcpServers))),
  );
  api.post(
    "/mcp/import",
    wrap(async (req, res) => {
      const picks = Array.isArray(req.body?.servers)
        ? (req.body.servers as unknown[]).slice(0, 30).map((p) => {
            const o = (p ?? {}) as Record<string, unknown>;
            return { source: String(o.source ?? ""), name: String(o.name ?? "") };
          })
        : [];
      const plan = importPlan(await discoverMcp(), picks, config.syncView().mcpServers);
      res.json(await config.setSync(plan));
    }),
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
  // About: version and where MultiCode keeps its data and its error log.
  api.get("/about", (_req, res) => {
    res.json({
      version: APP_VERSION,
      dataDir: opts.stateDir ?? null,
      projectsDir,
      errorLog: opts.stateDir ? path.join(opts.stateDir, "logs", "errors.log") : null,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
    });
  });
  // Subscription limits (as Claude's /usage shows them): how much is used and when it resets.
  api.get(
    "/usage",
    wrap(async (req, res) => {
      const fresh = req.query.fresh === "1";
      const conns = config.connections.filter((c) =>
        (USAGE_KINDS as readonly string[]).includes(c.kind),
      );
      res.json(await Promise.all(conns.map((c) => accountUsage(c, fresh))));
    }),
  );
  // A connection's health: free and fast (no model is asked anything).
  api.get(
    "/connections/:id/check",
    wrap(async (req, res) => {
      const { conn, provider } = providerFor(param(req, "id"));
      res.json(await checkConnection(conn, provider, signIn));
    }),
  );
  // Real-API check that prompt caching saves tokens (two short calls; costs a few cents).
  api.post(
    "/connections/:id/cache-check",
    wrap(async (req, res) => {
      const conn = config.connection(param(req, "id"));
      if (!conn) throw new HttpError(404, "connection not found");
      res.json(await checkCaching(conn));
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
  // Pictures you paste or drop into the message box: saved in the project's .attachments folder
  // (hidden from the file tree and the crew's change list), then mentioned as @path.
  api.post(
    "/projects/:name/attachments",
    express.raw({ type: "image/*", limit: "5mb" }),
    wrap(async (req, res) => {
      const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();
      const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === type)?.[0];
      if (!ext) throw new HttpError(415, "attach a PNG, JPEG, WebP or GIF picture");
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "the picture is empty");
      const ws = await Workspace.open(projectsDir, validateProjectName(param(req, "name")));
      const rel = `.attachments/${randomUUID().slice(0, 8)}${ext === ".jpeg" ? ".jpg" : ext}`;
      await mkdir(path.dirname(ws.abs(rel)), { recursive: true });
      await writeFile(ws.abs(rel), req.body);
      res.status(201).json({ path: rel });
    }),
  );
  api.get(
    "/projects/:name/attachments/:file",
    wrap(async (req, res) => {
      const file = param(req, "file");
      if (!/^[0-9a-f]{8}\.(png|jpg|webp|gif)$/.test(file)) throw new HttpError(404, "no such picture");
      const ws = await Workspace.open(projectsDir, validateProjectName(param(req, "name")));
      const full = ws.abs(`.attachments/${file}`);
      if (!existsSync(full)) throw new HttpError(404, "no such picture");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.sendFile(full, { dotfiles: "allow" });
    }),
  );
  // Version control: status, commit, push (the user's own git and credentials).
  const projectRoot = async (req: express.Request) =>
    (await Workspace.open(projectsDir, validateProjectName(param(req, "name")))).root;
  api.get("/projects/:name/git", wrap(async (req, res) => res.json(await gitStatus(await projectRoot(req)))));
  api.post("/projects/:name/git/init", wrap(async (req, res) => res.json(await gitInit(await projectRoot(req)))));
  api.post(
    "/projects/:name/git/commit",
    wrap(async (req, res) => res.json(await gitCommit(await projectRoot(req), req.body?.message))),
  );
  api.post("/projects/:name/git/push", wrap(async (req, res) => res.json(await gitPush(await projectRoot(req)))));
  api.get("/projects/:name/git/branches", wrap(async (req, res) => res.json(await gitBranches(await projectRoot(req)))));
  api.post(
    "/projects/:name/git/checkout",
    wrap(async (req, res) => res.json(await gitCheckout(await projectRoot(req), req.body?.branch, req.body?.create === true))),
  );
  api.post("/projects/:name/git/pull", wrap(async (req, res) => res.json(await gitPull(await projectRoot(req)))));
  // Work on a GitHub (or any git) repository: clone it as a new project.
  api.post(
    "/projects/clone",
    wrap(async (req, res) => {
      const url = cloneUrl(req.body?.url);
      const existing = new Set((await listProjects(projectsDir)).map((p) => p.name));
      const base = repoName(url);
      let name = base;
      for (let i = 2; existing.has(name) || existsSync(path.join(projectsDir, name)); i++) name = `${base}-${i}`;
      await mkdir(projectsDir, { recursive: true });
      await gitClone(path.join(projectsDir, validateProjectName(name)), url);
      res.status(201).json({ name });
    }),
  );
  api.put(
    "/projects/:name/check",
    wrap(async (req, res) => {
      await setProjectCheck(projectsDir, param(req, "name"), req.body?.check ?? null);
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
  api.get("/approvals", (_req, res) => res.json(runs.pendingApprovals()));
  // Chats: rename, pin, archive (hide) or delete one, with all its turns.
  api.patch("/chats/:id", wrap(async (req, res) => res.json(await runs.updateChat(param(req, "id"), req.body ?? {}))));
  api.delete(
    "/chats/:id",
    wrap(async (req, res) => {
      await runs.deleteChat(param(req, "id"));
      res.status(204).end();
    }),
  );
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
          req.body?.parentId,
          { review: req.body?.review === true, parallel: req.body?.parallel === true },
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
