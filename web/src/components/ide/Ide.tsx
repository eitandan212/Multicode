import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../api";
import { Icon } from "../Icon";
import { applyTheme, monaco } from "./monaco";

interface Props {
  project: string;
  /** Bumps whenever the crew changed files. */
  refreshKey: number;
  /** Files the current run changed (marked in the explorer). */
  changed: string[];
  /** The crew is working on this project: editing pauses so nobody overwrites anybody. */
  busy: boolean;
  /** The AI chat (thread + composer), docked on the right like an assistant panel. */
  chat: ReactNode;
}

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tar|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|wasm|exe|dll)$/i;

interface Tab {
  path: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  view?: monaco.editor.ICodeEditorViewState | null;
}

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const f of files) {
    const parts = f.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const dir = i < parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.dir === dir);
      if (!child)
        node.children.push((child = { name: part, path, dir, children: [] }));
      node = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** VS Code-style workspace: explorer, tabs, Monaco editor, status bar, and the AI chat docked. */
export default function Ide({
  project,
  refreshKey,
  changed,
  busy,
  chat,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [conflicts, setConflicts] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const changedSet = useMemo(() => new Set(changed), [changed]);
  const tree = useMemo(() => buildTree(files), [files]);

  const flash = (text: string, bad = false) => {
    setStatus({ text, bad });
    window.setTimeout(
      () => setStatus((s) => (s?.text === text ? null : s)),
      4000,
    );
  };
  const tab = (path: string | null) =>
    tabsRef.current.find((t) => t.path === path);
  const syncDirty = useCallback(() => {
    setDirty(
      new Set(
        tabsRef.current
          .filter((t) => t.model.getAlternativeVersionId() !== t.savedVersion)
          .map((t) => t.path),
      ),
    );
  }, []);

  // One editor for the whole session; tabs swap models in and out.
  useEffect(() => {
    applyTheme();
    const ed = monaco.editor.create(host.current!, {
      automaticLayout: true,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--mono") ||
        "monospace",
      fontSize: 13.5,
      fontLigatures: false,
      minimap: { enabled: true, renderCharacters: false },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      cursorBlinking: "smooth",
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      renderLineHighlight: "all",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active" },
      stickyScroll: { enabled: true },
      tabSize: 2,
    });
    editor.current = ed;
    ed.onDidChangeCursorPosition((e) =>
      setCursor({ line: e.position.lineNumber, col: e.position.column }),
    );
    // Follow the app's theme (light/dark/accent) as it changes.
    const retheme = () => applyTheme();
    const obs = new MutationObserver(retheme);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent", "style"],
    });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", retheme);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", retheme);
      ed.dispose();
      tabsRef.current.forEach((t) => t.model.dispose());
      tabsRef.current = [];
    };
  }, []);

  const save = useCallback(
    async (path = activeRef.current) => {
      const t = tab(path);
      if (!t) return;
      try {
        await api.saveFile(project, t.path, t.model.getValue());
        t.savedVersion = t.model.getAlternativeVersionId();
        setConflicts((c) => {
          const n = new Set(c);
          n.delete(t.path);
          return n;
        });
        syncDirty();
        flash(`Saved ${t.path}`);
        if (!files.includes(t.path)) setFiles((f) => [...f, t.path].sort());
      } catch (e) {
        flash((e as Error).message, true);
      }
    },
    [project, files, syncDirty],
  );
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void saveRef.current(),
    );
  }, []);

  useEffect(() => {
    editor.current?.updateOptions({
      readOnly: busy,
      readOnlyMessage: {
        value:
          "The crew is working on this project. Editing resumes when it's done.",
      },
    });
  }, [busy]);

  // Switching projects closes everything from the previous one.
  useEffect(() => {
    tabsRef.current.forEach((t) => t.model.dispose());
    tabsRef.current = [];
    setTabs([]);
    setActive(null);
    activeRef.current = null;
    setDirty(new Set());
    setConflicts(new Set());
    editor.current?.setModel(null);
  }, [project]);

  // File list, and open tabs kept in step with what the crew writes.
  useEffect(() => {
    let live = true;
    api.files(project).then(
      (f) => live && setFiles(f),
      () => live && setFiles([]),
    );
    for (const t of tabsRef.current) {
      api.file(project, t.path).then(
        (r) => {
          if (!live || r.content === t.model.getValue()) return;
          if (t.model.getAlternativeVersionId() === t.savedVersion) {
            t.model.pushEditOperations(
              [],
              [{ range: t.model.getFullModelRange(), text: r.content }],
              () => null,
            );
            t.savedVersion = t.model.getAlternativeVersionId();
          } else setConflicts((c) => new Set(c).add(t.path));
        },
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [project, refreshKey]);

  /** Expands every folder above a file so it's visible in the explorer. */
  const reveal = (path: string) => {
    const parts = path.split("/").slice(0, -1);
    if (!parts.length) return;
    setOpen((o) => {
      const n = new Set(o);
      parts.forEach((_, i) => n.add(parts.slice(0, i + 1).join("/")));
      return n;
    });
  };

  const show = (path: string) => {
    const ed = editor.current!;
    const prev = tab(activeRef.current);
    if (prev) prev.view = ed.saveViewState();
    const t = tab(path)!;
    ed.setModel(t.model);
    if (t.view) ed.restoreViewState(t.view);
    ed.focus();
    activeRef.current = path;
    setActive(path);
    reveal(path);
  };

  const openFile = async (path: string) => {
    if (tab(path)) return show(path);
    if (BINARY.test(path)) return flash(`${path} is a binary file`, true);
    try {
      const { content } = await api.file(project, path);
      const model = monaco.editor.createModel(
        content,
        undefined,
        monaco.Uri.from({ scheme: "file", path: `/${project}/${path}` }),
      );
      const t: Tab = {
        path,
        model,
        savedVersion: model.getAlternativeVersionId(),
      };
      model.onDidChangeContent(() => syncDirty());
      tabsRef.current.push(t);
      setTabs(tabsRef.current.map((x) => x.path));
      show(path);
    } catch (e) {
      flash((e as Error).message, true);
    }
  };

  const closeTab = (path: string) => {
    const i = tabsRef.current.findIndex((t) => t.path === path);
    if (i < 0) return;
    const t = tabsRef.current[i]!;
    if (
      t.model.getAlternativeVersionId() !== t.savedVersion &&
      !window.confirm(`${path} has unsaved changes. Close it anyway?`)
    )
      return;
    tabsRef.current.splice(i, 1);
    setTabs(tabsRef.current.map((x) => x.path));
    if (activeRef.current === path) {
      const next = tabsRef.current[Math.min(i, tabsRef.current.length - 1)];
      if (next) show(next.path);
      else {
        editor.current?.setModel(null);
        activeRef.current = null;
        setActive(null);
      }
    }
    t.model.dispose();
    syncDirty();
  };

  const reloadFromDisk = async (path: string) => {
    const t = tab(path);
    if (!t) return;
    const { content } = await api.file(project, path);
    t.model.pushEditOperations(
      [],
      [{ range: t.model.getFullModelRange(), text: content }],
      () => null,
    );
    t.savedVersion = t.model.getAlternativeVersionId();
    setConflicts((c) => {
      const n = new Set(c);
      n.delete(path);
      return n;
    });
    syncDirty();
  };

  const createFile = async () => {
    const name = newName.trim().replace(/^\/+/, "");
    if (!name) return setCreating(false);
    try {
      await api.saveFile(project, name, "");
      setFiles((f) => [...new Set([...f, name])].sort());
      setCreating(false);
      setNewName("");
      await openFile(name);
    } catch (e) {
      flash((e as Error).message, true);
    }
  };

  const deleteFile = async (path: string) => {
    try {
      await api.deleteFile(project, path);
      setFiles((f) => f.filter((x) => x !== path));
      if (tab(path)) {
        tab(path)!.savedVersion = tab(path)!.model.getAlternativeVersionId();
        closeTab(path);
      }
      flash(`Deleted ${path}`);
    } catch (e) {
      flash((e as Error).message, true);
    } finally {
      setConfirmDelete(null);
    }
  };

  const language = active ? (tab(active)?.model.getLanguageId() ?? "") : "";

  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((n) =>
      n.dir ? (
        <div key={n.path} className="ide-dir">
          <button
            className="ide-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() =>
              setOpen((o) => {
                const s = new Set(o);
                if (s.has(n.path)) s.delete(n.path);
                else s.add(n.path);
                return s;
              })
            }
            aria-expanded={open.has(n.path)}
          >
            <Icon
              name={open.has(n.path) ? "chevronDown" : "chevron"}
              size={12}
            />
            <Icon name="folder" size={14} />
            <span className="truncate">{n.name}</span>
          </button>
          {open.has(n.path) && (
            <div className="ide-children">
              {renderNodes(n.children, depth + 1)}
            </div>
          )}
        </div>
      ) : (
        <div
          key={n.path}
          className={`ide-file ${active === n.path ? "is-active" : ""}`}
        >
          <button
            className="ide-row"
            style={{ paddingLeft: 22 + depth * 12 }}
            onClick={() => void openFile(n.path)}
            title={n.path}
          >
            <Icon name="file" size={13} />
            <span className="truncate">{n.name}</span>
            {dirty.has(n.path) && <span className="ide-dot" title="Unsaved" />}
            {changedSet.has(n.path) && (
              <span className="ide-badge" title="Changed by the crew">
                M
              </span>
            )}
          </button>
          {confirmDelete === n.path ? (
            <button
              className="ide-del is-confirm"
              onClick={() => void deleteFile(n.path)}
              disabled={busy}
            >
              Delete?
            </button>
          ) : (
            <button
              className="ide-del"
              onClick={() => setConfirmDelete(n.path)}
              aria-label={`Delete ${n.path}`}
              title="Delete"
              disabled={busy}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ),
    );

  return (
    <div className="ide">
      <aside className="ide-explorer" aria-label="Explorer">
        <div className="ide-pane-head">
          <span>Explorer</span>
          <button
            className="icon-btn"
            onClick={() => setCreating(true)}
            title="New file"
            aria-label="New file"
            disabled={busy}
          >
            <Icon name="compose" size={14} />
          </button>
        </div>
        <div className="ide-project truncate">
          <Icon name="folder" size={13} /> {project}
        </div>
        {creating && (
          <form
            className="ide-new"
            onSubmit={(e) => {
              e.preventDefault();
              void createFile();
            }}
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => !newName && setCreating(false)}
              onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
              placeholder="src/new-file.js"
              aria-label="New file name"
            />
          </form>
        )}
        <div className="ide-tree">
          {files.length ? (
            renderNodes(tree, 0)
          ) : (
            <p className="muted small ide-empty">
              No files yet. Ask the crew, or create one.
            </p>
          )}
        </div>
      </aside>

      <section className="ide-main">
        <div className="ide-tabs" role="tablist">
          {tabs.map((p) => (
            <div
              key={p}
              role="tab"
              aria-selected={active === p}
              className={`ide-tab ${active === p ? "is-active" : ""}`}
              onClick={() => show(p)}
              title={p}
            >
              <span className="truncate">{p.split("/").pop()}</span>
              <button
                className={`ide-tab-x ${dirty.has(p) ? "is-dirty" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(p);
                }}
                aria-label={`Close ${p}`}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
        {active && conflicts.has(active) && (
          <div className="ide-banner">
            <span>The crew changed this file while you were editing it.</span>
            <button
              className="btn small"
              onClick={() => void reloadFromDisk(active)}
            >
              Load their version
            </button>
            <button
              className="btn small primary"
              onClick={() => void save(active)}
              disabled={busy}
            >
              Keep mine and save
            </button>
          </div>
        )}
        {busy && (
          <div className="ide-banner is-info">
            The crew is working on this project. Editing resumes when it's done.
          </div>
        )}
        <div className="ide-editor-wrap">
          <div ref={host} className="ide-editor" />
          {!active && (
            <div className="ide-welcome">
              <Icon name="file" size={28} />
              <p>Open a file from the explorer</p>
              <p className="muted small">
                <kbd>Ctrl S</kbd> saves · <kbd>Ctrl F</kbd> finds ·{" "}
                <kbd>F1</kbd> editor commands
              </p>
            </div>
          )}
        </div>
        <footer className="ide-status">
          <span className="ide-status-item">
            <Icon name="folder" size={12} /> {project}
          </span>
          {active && <span className="ide-status-item truncate">{active}</span>}
          {status && (
            <span
              className={`ide-status-item ${status.bad ? "is-bad" : "is-ok"}`}
            >
              {status.text}
            </span>
          )}
          <span className="push-right" />
          {active && (
            <>
              <span className="ide-status-item">
                Ln {cursor.line}, Col {cursor.col}
              </span>
              <span className="ide-status-item">{language}</span>
              <span className="ide-status-item">
                {dirty.has(active) ? "Unsaved" : "Saved"}
              </span>
              <button
                className="ide-status-item ide-save"
                onClick={() => void save()}
                disabled={busy || !dirty.has(active)}
              >
                Save
              </button>
            </>
          )}
        </footer>
      </section>

      <aside className="ide-chat" aria-label="AI crew">
        {chat}
      </aside>
    </div>
  );
}
