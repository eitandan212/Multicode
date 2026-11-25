import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  RunEvent,
  RunMode,
  RunSummary,
  TeamChoice,
} from "../../server/shared";
import { api, type AppState } from "./api";
import { CommandPalette, type Command } from "./components/CommandPalette";
import {
  applyAppearance,
  loadAppearance,
  motionReduced,
  saveAppearance,
  type Appearance,
} from "./appearance";
import { AppearanceDialog } from "./components/AppearanceDialog";
import { Composer } from "./components/Composer";
import { SafetyDialog } from "./components/SafetyDialog";
import { Splash } from "./components/Splash";
import { ConnectionsDialog } from "./components/ConnectionsDialog";
import { CrewDialog } from "./components/CrewDialog";
import { Icon } from "./components/Icon";

import { LogoLoader, LogoMark } from "./components/Logo";
import { SettingsPage } from "./components/SettingsPage";
import { ProjectDialog } from "./components/ProjectDialog";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { usePresence } from "./motion";
import { EXAMPLE_PROMPTS, ProjectForm, Tutorial } from "./components/Tutorial";
import { SidePanel, type PanelTab } from "./components/SidePanel";
import { Sidebar } from "./components/Sidebar";
import { ExtensionsDialog } from "./components/ExtensionsDialog";
import { SyncDialog } from "./components/SyncDialog";
import { Thread } from "./components/Thread";
import { emptyRun, reduceRun, type RunView } from "./runState";

/** The IDE (Monaco) loads only when you open it, so Chat view stays light. */
const Ide = lazy(() => import("./components/ide/Ide"));

type RunAction =
  | { kind: "reset"; run: RunView | null }
  | { kind: "event"; event: RunEvent };

function runReducer(state: RunView | null, a: RunAction): RunView | null {
  if (a.kind === "reset") return a.run;
  return state ? reduceRun(state, a.event) : state;
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`multicode:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`multicode:${key}`, value);
    } catch {
      /* storage unavailable: fine */
    }
  },
};

const narrow = () => window.matchMedia("(max-width: 900px)").matches;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, dispatch] = useReducer(runReducer, null);
  const [dialog, setDialog] = useState<
    | "connections"
    | "crew"
    | "palette"
    | "sync"
    | "extensions"
    | "appearance"
    | "safety"
    | "project"
    | null
  >(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("preview");
  const [appearance, setAppearanceState] = useState<Appearance>(loadAppearance);
  // The intro plays once per browser session (and never with reduced motion).
  const [intro, setIntro] = useState(() => {
    const a = loadAppearance();
    let seen = false;
    try {
      seen = sessionStorage.getItem("multicode:intro") === "1";
    } catch {
      /* no storage: play it */
    }
    return a.intro && !seen && !motionReduced(a);
  });
  const endIntro = useCallback(() => {
    setIntro(false);
    try {
      sessionStorage.setItem("multicode:intro", "1");
    } catch {
      /* fine */
    }
  }, []);
  const setAppearance = (a: Appearance) => {
    setAppearanceState(a);
    applyAppearance(a);
    saveAppearance(a);
  };
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !narrow() && store.get("sidebar") !== "0",
  );
  const [panelOpen, setPanelOpen] = useState(
    () => !narrow() && store.get("panel") === "1",
  );
  // Who works: Auto, the configured crew, or one model alone (remembered in this browser).
  const [teamPref, setTeamPref] = useState<TeamChoice | null>(() => {
    try {
      return JSON.parse(store.get("team") ?? "null") as TeamChoice | null;
    } catch {
      return null;
    }
  });
  const chooseTeam = (t: TeamChoice) => {
    setTeamPref(t);
    store.set("team", JSON.stringify(t));
  };
  // A solo pick whose connection was removed, or no pick yet, falls back to a sensible default.
  const team: TeamChoice = (() => {
    if (
      teamPref?.kind === "solo" &&
      state?.connections.some((c) => c.id === teamPref.connectionId)
    )
      return teamPref;
    if (teamPref && teamPref.kind !== "solo") return teamPref;
    return state?.crew.length ? { kind: "crew" } : { kind: "auto" };
  })();

  // Chat or IDE (VS Code-like editor with the crew docked beside it), remembered per browser.
  const [view, setViewState] = useState<"chat" | "ide">(() =>
    store.get("view") === "ide" ? "ide" : "chat",
  );
  const setView = (v: "chat" | "ide") => {
    setViewState(v);
    store.set("view", v);
  };

  // Sidebar and panel stay mounted while they slide out.
  const sidebarPresence = usePresence(sidebarOpen);
  const panelPresence = usePresence(panelOpen && Boolean(project));
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.state(), api.allRuns()]);
      setState(s);
      setRuns(r);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keyboard shortcuts. The handler is refreshed every render so it always sees current state.
  const shortcut = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => shortcut.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pick the last project once state has loaded. Nothing is created for the user: the
  // tutorial walks them through naming their own first project.
  useEffect(() => {
    if (!state || project) return;
    const last = store.get("project");
    const existing =
      state.projects.find((p) => p.name === last) ?? state.projects[0];
    if (existing) setProject(existing.name);
  }, [state, project]);

  const [tutorial, setTutorial] = useState(
    () => store.get("tutorial") !== "done",
  );
  // People who already built something skip the guide (until they ask for it again).
  const runsLoaded = runs.length > 0;
  useEffect(() => {
    if (runsLoaded && store.get("tutorial") === null) {
      setTutorial(false);
      store.set("tutorial", "done");
    }
  }, [runsLoaded]);
  const endTutorial = () => {
    setTutorial(false);
    store.set("tutorial", "done");
  };
  const showTutorial = () => {
    setTutorial(true);
    store.set("tutorial", "");
    dispatch({ kind: "reset", run: null });
  };
  // A prompt picked in the tutorial, handed to the composer (n changes on every pick).
  const [farFromEnd, setFarFromEnd] = useState(false);
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>();
  const createFirstProject = async (name: string) => {
    const p = await api.createProject(name);
    await reload();
    selectProject(p.name);
  };

  const selectProject = (name: string) => {
    if (name === project) return;
    setProject(name);
    store.set("project", name);
    dispatch({ kind: "reset", run: null });
    if (narrow()) setSidebarOpen(false);
  };

  const selectRun = (r: RunSummary) => {
    if (r.project !== project) {
      setProject(r.project);
      store.set("project", r.project);
    }
    dispatch({ kind: "reset", run: emptyRun(r.id, r.prompt) });
    if (narrow()) setSidebarOpen(false);
  };

  const bumpPreview = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(
      () => setRefreshKey((k) => k + 1),
      600,
    );
  }, []);

  // Stream the selected thread's events (replays history first).
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return;
    return api.events(runId, (event) => {
      dispatch({ kind: "event", event });
      if (event.type === "file.changed" || event.type === "run.done")
        bumpPreview();
      if (event.type === "run.done" || event.type === "run.error")
        void reload();
    });
  }, [runId, bumpPreview, reload]);

  const busy = useMemo(
    () =>
      new Set(
        run?.streams
          .filter((s) => s.status === "live")
          .map((s) => s.memberId) ?? [],
      ),
    [run?.streams],
  );

  const showChanges = () => {
    setPanelTab("changes");
    togglePanel(true);
  };

  const togglePanel = (open: boolean) => {
    setPanelOpen(open);
    // Sidebar + chat + panel don't fit side by side below ~1200px: the panel takes the sidebar's room.
    if (open && window.innerWidth < 1200) setSidebarOpen(false);
    if (!narrow()) store.set("panel", open ? "1" : "0");
  };
  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    if (!narrow()) store.set("sidebar", open ? "1" : "0");
  };

  const startRun = async (prompt: string, mode: RunMode = "build") => {
    if (!project) return;
    const summary = await api.startRun(project, prompt, mode, team);
    setRuns((rs) => [summary, ...rs]);
    if (tutorial) endTutorial();
    dispatch({ kind: "reset", run: emptyRun(summary.id, summary.prompt) });
  };

  const focusComposer = () =>
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  const newThread = () => {
    dispatch({ kind: "reset", run: null });
    if (narrow()) setSidebarOpen(false);
    focusComposer();
  };
  shortcut.current = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(input|textarea|select)$/i.test(e.target.tagName));
    if (mod && key === "k") {
      e.preventDefault();
      setDialog((d) => (d === "palette" ? null : (d ?? "palette")));
    } else if (mod && !e.shiftKey && key === "b") {
      e.preventDefault();
      toggleSidebar(!sidebarOpen);
    } else if (mod && !e.shiftKey && key === "j") {
      e.preventDefault();
      togglePanel(!panelOpen);
    } else if (mod && !e.shiftKey && key === "e" && project && !typing) {
      e.preventDefault();
      setView(view === "ide" ? "chat" : "ide");
    } else if (mod && e.shiftKey && key === "o") {
      e.preventDefault();
      newThread();
    } else if (key === "/" && !mod && !typing && !dialog) {
      e.preventDefault();
      focusComposer();
    }
  };

  // window.prompt doesn't exist in the desktop app, so projects get a real dialog.
  const newProject = () => setDialog("project");

  const commands = (): Command[] => {
    if (!state) return [];
    const cmds: Command[] = [
      {
        id: "new-thread",
        label: "New thread",
        icon: "compose",
        group: "Actions",
        run: () => dispatch({ kind: "reset", run: null }),
      },
      {
        id: "toggle-ide",
        label: view === "ide" ? "Switch to Chat view" : "Switch to IDE view",
        hint: "editor, explorer and tabs with the crew beside you",
        icon: view === "ide" ? "compose" : "terminal",
        group: "View",
        run: () => setView(view === "ide" ? "chat" : "ide"),
      },
      {
        id: "tutorial",
        label: "Show the tutorial",
        hint: "getting started, step by step",
        icon: "spark",
        group: "View",
        run: showTutorial,
      },
      {
        id: "new-project",
        label: "New project",
        icon: "folderPlus",
        group: "Actions",
        run: () => void newProject(),
      },
      {
        id: "crew",
        label: "Edit crew",
        icon: "users",
        group: "Actions",
        run: () => setDialog("crew"),
      },
      {
        id: "safety",
        label: "Savings & safety",
        hint: "economy, free fallback, sandbox, protected files",
        icon: "shield",
        group: "Actions",
        run: () => setDialog("safety"),
      },
      {
        id: "appearance",
        label: "Appearance",
        hint: "theme, accent colour, font, size, motion",
        icon: "palette",
        group: "View",
        run: () => setDialog("appearance"),
      },
      {
        id: "extensions",
        label: "Plugins & skills",
        hint: "memory graph, AI browser, computer control, skill packs",
        icon: "puzzle",
        group: "Actions",
        run: () => setDialog("extensions"),
      },
      {
        id: "sync",
        label: "Sync across harnesses",
        hint: "instructions, MCP servers, memory",
        icon: "sync",
        group: "Actions",
        run: () => setDialog("sync"),
      },
      {
        id: "connections",
        label: "Connections",
        hint: "subscriptions, API keys, agents",
        icon: "plug",
        group: "Actions",
        run: () => setDialog("connections"),
      },
      {
        id: "toggle-sidebar",
        label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
        icon: "sidebar",
        group: "View",
        run: () => toggleSidebar(!sidebarOpen),
      },
      {
        id: "toggle-panel",
        label: panelOpen ? "Hide crew and preview" : "Show crew and preview",
        icon: "panelRight",
        group: "View",
        run: () => togglePanel(!panelOpen),
      },
      {
        id: "preview",
        label: "Show preview",
        icon: "globe",
        group: "View",
        run: () => {
          setPanelTab("preview");
          togglePanel(true);
        },
      },
      {
        id: "files",
        label: "Show files",
        icon: "file",
        group: "View",
        run: () => {
          setPanelTab("files");
          togglePanel(true);
        },
      },
      {
        id: "changes",
        label: "Show changes",
        icon: "list",
        group: "View",
        run: showChanges,
      },
    ];
    if (run?.status === "running")
      cmds.unshift({
        id: "stop",
        label: "Stop the crew",
        icon: "stop",
        group: "Actions",
        run: () => void api.cancelRun(run.id),
      });
    for (const pr of state.projects)
      cmds.push({
        id: `project-${pr.name}`,
        label: pr.name,
        hint: `${pr.fileCount} files`,
        icon: "folder",
        group: "Projects",
        run: () => selectProject(pr.name),
      });
    for (const r of runs)
      cmds.push({
        id: `run-${r.id}`,
        label: r.prompt,
        hint: r.project,
        icon: "terminal",
        group: "Threads",
        run: () => selectRun(r),
      });
    return cmds;
  };

  const splash = intro && <Splash onDone={endIntro} />;

  if (!state) {
    return (
      <div className="boot">
        {splash}
        {loadError ? (
          <p className="err-text">
            MultiCode's server isn't reachable: {loadError}. Start it with{" "}
            <code>npm start</code>.
          </p>
        ) : (
          <p className="muted">Loading MultiCode…</p>
        )}
      </div>
    );
  }

  const crew = state.effectiveCrew;
  const canRun = state.connections.length > 0 && Boolean(project);
  const running = run?.status === "running";
  const composer = project && (
    <Composer
      crew={crew}
      connections={state.connections}
      team={team}
      onTeam={chooseTeam}
      manager={state.manager}
      settings={state.settings}
      project={project}
      canRun={canRun}
      running={running}
      progress={
        run
          ? {
              done: run.tasks.filter(
                (t) => t.status === "done" || t.status === "failed",
              ).length,
              total: run.tasks.length,
            }
          : undefined
      }
      placeholder={
        canRun
          ? run
            ? "Ask for a change. The crew plans, builds and reviews it."
            : "Ask anything. The crew plans, builds and reviews it."
          : "Connect an AI to start"
      }
      draft={draft}
      onSubmit={startRun}
      onStop={() => run && void api.cancelRun(run.id)}
      onOpenCrew={() => setDialog("crew")}
      onOpenSafety={() => setDialog("safety")}
      onSettings={async (patch) => {
        await api.saveSettings(patch);
        await reload();
      }}
    />
  );

  // The conversation with the crew: full width in Chat view, docked beside the editor in IDE view.
  const chatView =
    run && project ? (
      <>
        <div className="scroll" onScroll={(e) => {
          const el = e.currentTarget;
          setFarFromEnd(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
        }}>
          <Thread
            onAnswer={async (id, allow, always) => {
              await api.approve(run.id, id, allow, always);
            }}
            onReuse={(text) => {
              setDraft((d) => ({ text, n: (d?.n ?? 0) + 1 }));
            }}
            run={run}
            crew={crew}
            connections={state.connections}
            undo={{
              can: Boolean(runs.find((r) => r.id === run.id)?.canUndo),
              undoneAt: runs.find((r) => r.id === run.id)?.undoneAt,
            }}
            review={{
              pending: runs.find((r) => r.id === run.id)?.pending,
              resolution: runs.find((r) => r.id === run.id)?.resolution,
            }}
            onApply={async (variant, force) => {
              const r = await api.apply(run.id, variant, force);
              if (!r.conflicts.length) {
                await reload();
                setRefreshKey((k) => k + 1);
              }
              return r;
            }}
            onDiscard={async () => {
              await api.discard(run.id);
              await reload();
            }}
            onShowChanges={showChanges}
            onUndo={async (force) => {
              const r = await api.undo(run.id, force);
              if (!r.conflicts.length) {
                await reload();
                setRefreshKey((k) => k + 1);
              }
              return r;
            }}
          />
        </div>
        {farFromEnd && (
          <button
            className="jump-latest enter"
            title="Jump to latest"
            onClick={(e) => {
              const sc = (e.currentTarget.parentElement?.querySelector(".scroll") as HTMLElement | null);
              sc?.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
            }}
          >
            <Icon name="chevron" size={14} /> Latest
          </button>
        )}
        <div className="dock">{composer}</div>
      </>
    ) : tutorial || !project ? (
      <div className="hero">
        {tutorial ? (
          <Tutorial
            hasConnection={state.connections.length > 0}
            crewSize={crew.length}
            hasProject={Boolean(project)}
            hasRun={runs.length > 0}
            onConnect={() => setDialog("connections")}
            onEditCrew={() => setDialog("crew")}
            onCreateProject={createFirstProject}
            onExample={(text) =>
              setDraft((d) => ({ text, n: (d?.n ?? 0) + 1 }))
            }
            onSkip={endTutorial}
          />
        ) : (
          <section className="tutorial">
            <LogoMark size={40} className="hero-mark" />
            <h1>Create a project to start</h1>
            <p className="muted">
              A folder on this computer where the crew writes the code.
            </p>
            <ProjectForm onCreate={createFirstProject} />
          </section>
        )}
        {composer}
      </div>
    ) : (
      // An empty thread, as in T3 Code: a quiet line in the middle, the composer docked below.
      <>
        <div className="scroll empty-thread">
          {state.connections.length === 0 ? (
            <p className="muted">
              <button className="link" onClick={() => setDialog("connections")}>
                Connect an AI
              </button>{" "}
              to start the conversation.
            </p>
          ) : (
            <div className="empty-start">
              <p className="muted">Send a message to start the conversation.</p>
              <div className="suggestions" aria-label="Ideas to start with">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button key={ex} className="suggestion" onClick={() => setDraft((d) => ({ text: ex, n: (d?.n ?? 0) + 1 }))}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="dock">{composer}</div>
      </>
    );

  return (
    <div
      className={`shell ${sidebarOpen ? "with-sidebar" : ""} ${panelOpen ? "with-panel" : ""}`}
    >
      {sidebarPresence.mounted && (
        <>
          <div
            className={`slot slot-left ${sidebarPresence.closing ? "is-closing" : ""}`}
            inert={!sidebarOpen}
          >
            <Sidebar
              projects={state.projects}
              runs={runs}
              connections={state.connections}
              project={project}
              runId={run?.id ?? null}
              onSelectProject={selectProject}
              onSelectRun={selectRun}
              onNewThread={newThread}
              onNewProject={newProject}
              onOpenSettings={setDialog}
              onCollapse={() => toggleSidebar(false)}
            />
          </div>
          <div
            className={`scrim ${sidebarPresence.closing ? "is-closing" : ""}`}
            onClick={() => toggleSidebar(false)}
            aria-hidden
          />
        </>
      )}

      <main className="main">
        <header className="topbar">
          {!sidebarOpen && (
            <button
              className="icon-btn"
              onClick={() => toggleSidebar(true)}
              aria-label="Show sidebar"
              title="Show sidebar"
            >
              <Icon name="sidebar" />
            </button>
          )}
          <div
            className="crumbs truncate"
            key={`${project ?? ""}/${run?.id ?? "new"}`}
          >
            {project ? (
              <>
                <ProjectSwitcher
                  project={project}
                  projects={state.projects}
                  onSelect={selectProject}
                  onNew={newProject}
                  onUnlink={async (name) => {
                    await api.unlinkProject(name);
                    await reload();
                  }}
                />
                <span className="muted sep">/</span>
                <span className="truncate">
                  {run ? run.prompt : "New thread"}
                </span>
              </>
            ) : (
              <span>Getting started</span>
            )}
          </div>
          <div className="topbar-tools">
            {project && (
              <button
                className={`icon-btn ${view === "ide" ? "is-on" : ""}`}
                onClick={() => setView(view === "ide" ? "chat" : "ide")}
                aria-label={
                  view === "ide" ? "Close the editor" : "Open the editor"
                }
                aria-pressed={view === "ide"}
                title={
                  view === "ide"
                    ? "Close the editor (IDE)"
                    : "Open the editor (IDE)"
                }
              >
                <Icon name="terminal" />
              </button>
            )}
            <button
              className={`icon-btn ${panelOpen ? "is-on" : ""}`}
              onClick={() => togglePanel(!panelOpen)}
              aria-label={
                panelOpen ? "Hide crew and preview" : "Show crew and preview"
              }
              aria-pressed={panelOpen}
              title="Crew and preview"
            >
              <Icon name="panelRight" />
            </button>
          </div>
        </header>

        {view === "ide" && project ? (
          <Suspense
            fallback={
              <div className="ide-loading">
                <LogoLoader size={22} /> Loading the editor…
              </div>
            }
          >
            <Ide
              project={project}
              refreshKey={refreshKey}
              changed={run?.changed ?? []}
              busy={runs.some(
                (r) => r.project === project && r.status === "running",
              )}
              chat={chatView}
            />
          </Suspense>
        ) : (
          chatView
        )}
      </main>

      {panelPresence.mounted && project && (
        <>
          <div
            className={`slot slot-right ${panelPresence.closing ? "is-closing" : ""}`}
            inert={!panelOpen}
          >
            <SidePanel
              project={project}
              crew={crew}
              connections={state.connections}
              busy={busy}
              refreshKey={refreshKey}
              changed={run?.changed ?? []}
              diff={run?.diff}
              tab={panelTab}
              onTab={setPanelTab}
              onOpenCrew={() => setDialog("crew")}
              onOpenConnections={() => setDialog("connections")}
              onOpenSync={() => setDialog("sync")}
              onOpenExtensions={() => setDialog("extensions")}
              onOpenSafety={() => setDialog("safety")}
              limits={state.limits}
            />
          </div>
          <button
            className={`panel-close icon-btn ${panelPresence.closing ? "is-closing" : ""}`}
            onClick={() => togglePanel(false)}
            aria-label="Close panel"
          >
            <Icon name="x" />
          </button>
        </>
      )}

      {dialog === "project" && (
        <ProjectDialog
          onClose={() => setDialog(null)}
          onCreate={async (name) => {
            const p = await api.createProject(name);
            await reload();
            selectProject(p.name);
          }}
          onOpenFolder={async (folder) => {
            const p = await api.openFolder(folder);
            await reload();
            selectProject(p.name);
          }}
        />
      )}
      {dialog === "palette" && (
        <CommandPalette commands={commands()} onClose={() => setDialog(null)} />
      )}
      {dialog && dialog !== "palette" && dialog !== "project" && (
        <SettingsPage
          section={dialog}
          onSection={setDialog}
          onClose={() => setDialog(null)}
          onTutorial={() => {
            setDialog(null);
            showTutorial();
          }}
          render={(section, done) => {
            switch (section) {
              case "extensions":
                return <ExtensionsDialog onClose={done} />;
              case "safety":
                return (
                  <SafetyDialog
                    state={state}
                    onClose={done}
                    onChanged={reload}
                  />
                );
              case "appearance":
                return (
                  <AppearanceDialog
                    value={appearance}
                    onChange={setAppearance}
                    onReplayIntro={() => {
                      setDialog(null);
                      setIntro(true);
                    }}
                    onClose={done}
                  />
                );
              case "sync":
                return project ? (
                  <SyncDialog project={project} onClose={done} />
                ) : (
                  <p className="muted settings-empty">
                    Create a project first: sync writes into a project's folder.
                  </p>
                );
              case "connections":
                return (
                  <ConnectionsDialog
                    state={state}
                    onClose={done}
                    onChanged={reload}
                  />
                );
              case "crew":
                return (
                  <CrewDialog
                    state={state}
                    onClose={done}
                    onChanged={reload}
                    onOpenConnections={() => setDialog("connections")}
                  />
                );
            }
          }}
        />
      )}
      {splash}
    </div>
  );
}
