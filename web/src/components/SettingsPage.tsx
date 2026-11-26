import { useEffect, useRef, useState, type ReactNode } from "react";
import { EmbeddedContext } from "./embed";
import { Icon, type IconName } from "./Icon";

export type SettingsSection =
  | "general"
  | "keybindings"
  | "hooks"
  | "projects"
  | "about"
  | "appearance"
  | "connections"
  | "crew"
  | "safety"
  | "usage"
  | "extensions"
  | "sync";

const NAV: {
  group: string;
  items: { id: SettingsSection; label: string; icon: IconName }[];
}[] = [
  {
    group: "Preferences",
    items: [
      { id: "general", label: "General", icon: "bell" },
      { id: "appearance", label: "Appearance", icon: "palette" },
    ],
  },
  {
    group: "Agents",
    items: [
      { id: "connections", label: "Connections", icon: "plug" },
      { id: "crew", label: "Crew & agents", icon: "users" },
      { id: "usage", label: "Usage & limits", icon: "graph" },
      { id: "safety", label: "Savings & safety", icon: "shield" },
    ],
  },
  {
    group: "Tools",
    items: [
      { id: "extensions", label: "Plugins & skills", icon: "puzzle" },
      { id: "sync", label: "Tools (MCP) & sync", icon: "sync" },
      { id: "hooks", label: "Hooks", icon: "terminal" },
    ],
  },
  {
    group: "Workspace",
    items: [
      { id: "projects", label: "Projects", icon: "folder" },
      { id: "about", label: "About", icon: "info" },
    ],
  },
];

const LABEL = Object.fromEntries(
  NAV.flatMap((g) => g.items.map((i) => [i.id, i.label])),
) as Record<SettingsSection, string>;

interface Props {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onTutorial: () => void;
  /** Renders a section; `done` is called when the section finishes (e.g. after saving). */
  render: (s: SettingsSection, done: () => void) => ReactNode;
}

/** Every setting on one page: navigation on the left, the chosen section on the right. */
export function SettingsPage(p: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  // A section that finishes (Save) is shown again fresh instead of closing the page.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const q = query.trim().toLowerCase();

  return (
    <dialog
      ref={ref}
      className="settings-page"
      onClose={p.onClose}
      onCancel={p.onClose}
      // Focus inside a section's inline dialog keeps Escape from reaching this one: close here.
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          ref.current?.close();
        }
      }}
      aria-label="Settings"
    >
      <nav className="settings-nav">
        <label className="search-field settings-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search settings"
          />
        </label>
        {NAV.map((g) => {
          const items = g.items.filter(
            (i) => !q || i.label.toLowerCase().includes(q),
          );
          if (!items.length) return null;
          return (
            <div key={g.group} className="settings-group">
              <span className="settings-group-title">{g.group}</span>
              {items.map((i) => (
                <button
                  key={i.id}
                  className={`settings-item ${p.section === i.id ? "is-active" : ""}`}
                  onClick={() => p.onSection(i.id)}
                  aria-current={p.section === i.id ? "page" : undefined}
                >
                  <Icon name={i.icon} size={15} />
                  {i.label}
                </button>
              ))}
            </div>
          );
        })}
        <div className="settings-group push-bottom">
          <button className="settings-item" onClick={p.onTutorial}>
            <Icon name="spark" size={15} />
            Tutorial
          </button>
        </div>
      </nav>
      <section className="settings-main">
        <header className="settings-head">
          <span className="muted">Settings</span>
          <span className="muted sep">/</span>
          <span>{LABEL[p.section]}</span>
          <button
            className="icon-btn push-right"
            onClick={() => ref.current?.close()}
            aria-label="Close settings"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="settings-content" key={`${p.section}-${generation}`}>
          <EmbeddedContext.Provider value={true}>
            {p.render(p.section, () => setGeneration((g) => g + 1))}
          </EmbeddedContext.Provider>
        </div>
      </section>
    </dialog>
  );
}
