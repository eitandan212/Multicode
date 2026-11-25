// "/" commands and "@" file mentions in the message box, as in Claude Code and Codex.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon, type IconName } from "./Icon";

export type SlashId =
  | "new"
  | "plan"
  | "direct"
  | "sandbox"
  | "build"
  | "design"
  | "sleep"
  | "ask"
  | "auto-edit"
  | "approve-all"
  | "usage"
  | "connections"
  | "crew"
  | "changes"
  | "memory"
  | "ide"
  | "settings"
  | "help";

export const SLASH: { id: SlashId; hint: string; icon: IconName }[] = [
  { id: "new", hint: "Start a new thread", icon: "compose" },
  { id: "plan", hint: "Plan only: the crew changes nothing", icon: "list" },
  { id: "direct", hint: "Work directly in the project (with undo)", icon: "pencil" },
  { id: "sandbox", hint: "Work in a sandbox; you apply the result", icon: "shield" },
  { id: "build", hint: "MultiBuild: plan, build and review together", icon: "hammer" },
  { id: "design", hint: "MultiDesign: several designs, you pick one", icon: "palette" },
  { id: "sleep", hint: "Sleep mode on or off: the crew works alone", icon: "moon" },
  { id: "ask", hint: "Ask before every change and tool", icon: "eye" },
  { id: "auto-edit", hint: "Accept edits, ask for other tools", icon: "check" },
  { id: "approve-all", hint: "Approve everything automatically", icon: "spark" },
  { id: "usage", hint: "Usage & limits of your subscriptions", icon: "graph" },
  { id: "connections", hint: "Connect models, agents and APIs", icon: "plug" },
  { id: "crew", hint: "Choose who plans, builds and reviews", icon: "users" },
  { id: "changes", hint: "Show what changed", icon: "file" },
  { id: "memory", hint: "Open the memory graph", icon: "graph" },
  { id: "ide", hint: "Switch between Chat and IDE view", icon: "terminal" },
  { id: "settings", hint: "Open settings", icon: "settings" },
  { id: "help", hint: "Keyboard shortcuts and commands", icon: "keyboard" },
];

export type Trigger = { kind: "slash"; query: string } | { kind: "file"; query: string; start: number } | null;

/** What the text before the caret asks for: "/cmd" alone on the box, or "@path" at the caret. */
export function triggerAt(text: string, caret: number): Trigger {
  const before = text.slice(0, caret);
  const slash = /^\/([\w-]*)$/.exec(before);
  if (slash && caret === text.length) return { kind: "slash", query: slash[1]!.toLowerCase() };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "file", query: at[2]!.toLowerCase(), start: caret - at[2]!.length - 1 };
  return null;
}

/** Best file matches: the name first, then the path, shortest first. */
export function rankFiles(files: string[], q: string, max = 8): string[] {
  if (!q) return files.slice(0, max);
  const scored: [number, string][] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score * 1000 + f.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, max).map(([, f]) => f);
}

export type Item = { key: string; label: string; hint: string; icon: IconName };

export function useSuggest(project: string, trigger: Trigger) {
  const [files, setFiles] = useState<string[] | null>(null);
  const loadedFor = useRef("");
  useEffect(() => {
    if (trigger?.kind !== "file" || loadedFor.current === project) return;
    loadedFor.current = project;
    void api.files(project).then(setFiles).catch(() => setFiles([]));
  }, [trigger?.kind, project]);
  useEffect(() => {
    loadedFor.current = "";
    setFiles(null);
  }, [project]);

  return useMemo<Item[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "slash")
      // Name matches first (exact, then prefix), description matches after them.
      return SLASH.map((c) => ({
        c,
        rank: c.id === trigger.query ? 0 : c.id.startsWith(trigger.query) ? 1 : c.hint.toLowerCase().includes(trigger.query) ? 2 : 3,
      }))
        .filter((x) => x.rank < 3)
        .sort((a, b) => a.rank - b.rank)
        .map(({ c }) => ({ key: c.id, label: `/${c.id}`, hint: c.hint, icon: c.icon }));
    return rankFiles(files ?? [], trigger.query).map((f) => ({
      key: f,
      label: f.slice(f.lastIndexOf("/") + 1),
      hint: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "",
      icon: "file",
    }));
  }, [trigger, files]);
}

export function SuggestMenu(p: { items: Item[]; active: number; onPick: (i: number) => void; title: string }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.children[p.active]?.scrollIntoView({ block: "nearest" });
  }, [p.active]);
  if (!p.items.length) return null;
  return (
    <div className="suggest menu-pop" role="presentation">
      <span className="suggest-title">{p.title}</span>
      <ul ref={list} role="listbox" aria-label={p.title}>
        {p.items.map((it, i) => (
          <li
            key={it.key}
            role="option"
            aria-selected={i === p.active}
            className={i === p.active ? "is-active" : ""}
            onMouseDown={(e) => {
              e.preventDefault();
              p.onPick(i);
            }}
          >
            <Icon name={it.icon} size={14} />
            <span className="suggest-label">{it.label}</span>
            <span className="suggest-hint truncate">{it.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
