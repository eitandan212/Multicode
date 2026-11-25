import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  group: string;
  run: () => void;
}

/** Ctrl/Cmd+K launcher: type to filter, arrows to move, Enter to run. */
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return commands
      .filter((c) =>
        words.every((w) =>
          `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(w),
        ),
      )
      .slice(0, 50);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    ref.current?.close();
    c.run();
  };

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      className="dialog palette"
      onClose={onClose}
      onCancel={onClose}
      aria-label="Command palette"
    >
      <label className="palette-search">
        <Icon name="search" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search threads, projects and actions"
          aria-label="Search commands"
          aria-controls="palette-list"
          aria-activedescendant={
            results[active] ? `cmd-${results[active].id}` : undefined
          }
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[active]);
            }
          }}
        />
        <kbd>Esc</kbd>
      </label>
      <ul id="palette-list" ref={list} className="palette-list" role="listbox">
        {results.length === 0 && <li className="palette-empty">No matches</li>}
        {results.map((c, i) => {
          const header = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <li key={c.id} role="presentation">
              {header && <div className="palette-group">{header}</div>}
              <button
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={`palette-item ${i === active ? "is-active" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(c)}
              >
                <Icon name={c.icon} size={15} />
                <span className="truncate">{c.label}</span>
                {c.hint && (
                  <span className="muted truncate palette-hint">{c.hint}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
