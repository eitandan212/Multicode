import { useEffect, useRef, useState } from "react";
import type { ProjectInfo } from "../../../server/shared";
import { usePresence } from "../motion";
import { Icon } from "./Icon";
import { ProjectBadge } from "./Sidebar";

/** The project chip in the top bar (as in T3 Code): badge + name, and a menu to switch. */
export function ProjectSwitcher(p: {
  project: string;
  projects: ProjectInfo[];
  onSelect: (name: string) => void;
  onNew: () => void;
  /** Removes an opened folder from the list (the folder is not touched). */
  onUnlink?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 160);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="project-switcher" ref={ref}>
      <button
        className={`project-chip ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch project"
      >
        <ProjectBadge name={p.project} size={16} />
        <span className="truncate">{p.project}</span>
      </button>
      {presence.mounted && (
        <div
          className={`menu-pop project-pop ${presence.closing ? "is-closing" : ""}`}
          role="menu"
          inert={!open}
        >
          <div className="team-list-head">Projects</div>
          {p.projects.map((pr) => (
            <div key={pr.name} className="menu-row">
            <button
              role="menuitemradio"
              title={pr.path ?? pr.name}
              aria-checked={pr.name === p.project}
              className={`menu-item ${pr.name === p.project ? "is-active" : ""}`}
              onClick={() => {
                setOpen(false);
                p.onSelect(pr.name);
              }}
            >
              <ProjectBadge name={pr.name} size={16} />
              <span className="truncate">{pr.name}</span>
              {pr.path && <span className="muted small linked-tag">folder</span>}
              {pr.name === p.project && (
                <Icon name="check" size={14} className="team-check" />
              )}
            </button>
            {pr.path && p.onUnlink && (
              <button
                className="icon-btn small-btn"
                title={`Remove from the list (keeps ${pr.path})`}
                aria-label={`Remove ${pr.name} from the list`}
                onClick={() => {
                  setOpen(false);
                  p.onUnlink!(pr.name);
                }}
              >
                <Icon name="x" size={13} />
              </button>
            )}
            </div>
          ))}
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              p.onNew();
            }}
          >
            <Icon name="folderPlus" size={15} /> New or open project…
          </button>
        </div>
      )}
    </div>
  );
}
