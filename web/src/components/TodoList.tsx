import { useCallback, useEffect, useRef, useState } from "react";
import type { Todo } from "../../../server/todos";
import { api } from "../api";
import { Icon } from "./Icon";

const OPEN_KEY = "multicode:todos-open";

/** Tells every to-do view (sidebar, pet) to reload. */
export function todosChanged(): void {
  window.dispatchEvent(new Event("multicode:todos"));
}

/** To-dos, polled (so the pet's window and this one stay in step) and reloaded on any change. */
export function useTodos(project?: string | null): [Todo[], () => void] {
  const [list, setList] = useState<Todo[]>([]);
  const load = useCallback(() => {
    void api
      .todos(project)
      .then(setList)
      .catch(() => {});
  }, [project]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    window.addEventListener("multicode:todos", load);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("multicode:todos", load);
      window.removeEventListener("focus", load);
    };
  }, [load]);
  return [list, load];
}

/**
 * The to-do list in the sidebar: this project's to-dos and the general ones. Tick, edit with a double click, delete, or send one to the crew as a new chat.
 */
export function TodoList({ project, onSend }: { project: string | null; onSend: (todo: Todo) => void }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  // This project's to-dos and the general ones (no project).
  const [all] = useTodos();
  const list = all.filter((t) => t.project === null || t.project === project);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const openCount = list.filter((t) => !t.done).length;
  const doneCount = list.length - openCount;

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* per-session only */
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    todosChanged();
  };
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void act(() => api.addTodo(t, project));
    inputRef.current?.focus();
  };

  return (
    <div className="sb-groups todo">
      <button className="sb-group" onClick={toggleOpen} aria-expanded={open}>
        <Icon name="check" size={13} />
        <span>To-dos</span>
        {openCount > 0 && <span className="sb-count">{openCount}</span>}
        <Icon name={open ? "chevronDown" : "chevron"} size={14} />
      </button>
      {open && (
        <div className="todo-body">
          <ul className="todo-list">
            {list.map((t) => (
              <li key={t.id} className={`todo-item ${t.done ? "is-done" : ""}`}>
                <button
                  className={`todo-check ${t.done ? "is-on" : ""}`}
                  role="checkbox"
                  aria-checked={t.done}
                  aria-label={t.done ? "Mark as not done" : "Mark as done"}
                  onClick={() => void act(() => api.updateTodo(t.id, { done: !t.done }))}
                >
                  {t.done && <Icon name="check" size={11} />}
                </button>
                {editing === t.id ? (
                  <input
                    className="todo-edit"
                    defaultValue={t.text}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      setEditing(null);
                      const v = e.currentTarget.value.trim();
                      if (v && v !== t.text) void act(() => api.updateTodo(t.id, { text: v }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        e.currentTarget.value = t.text;
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <span className="todo-text" title="Double-click to edit" onDoubleClick={() => setEditing(t.id)}>
                    {t.text}
                    {t.runId && !t.done && <span className="todo-tag">with the crew</span>}
                    {project && t.project === null && <span className="todo-tag">general</span>}
                  </span>
                )}
                <span className="todo-actions">
                  {!t.done && !t.runId && (
                    <button className="icon-btn tiny" title="Send to the crew" aria-label="Send to the crew" onClick={() => onSend(t)}>
                      <Icon name="arrowUp" size={13} />
                    </button>
                  )}
                  <button className="icon-btn tiny" title="Delete" aria-label="Delete" onClick={() => void act(() => api.deleteTodo(t.id))}>
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <form
            className="todo-add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Icon name="plus" size={13} />
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a to-do" maxLength={500} aria-label="New to-do" />
          </form>
          {doneCount > 0 && (
            <button className="todo-clear" onClick={() => void act(() => Promise.all(list.filter((t) => t.done).map((t) => api.deleteTodo(t.id))))}>
              Clear {doneCount} done
            </button>
          )}
          {error && <p className="err-text small">{error}</p>}
        </div>
      )}
    </div>
  );
}
