import { useEffect, useState } from "react";
import type { FileDiff } from "../../../server/shared";
import { Icon } from "./Icon";

const CHANGE_LABEL: Record<FileDiff["change"], string> = { added: "new", modified: "", deleted: "deleted" };

export function DiffView({ files }: { files: FileDiff[] | undefined }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Expand everything for small change sets; collapse when there are many files.
  useEffect(() => {
    setOpen(new Set((files ?? []).length <= 4 ? (files ?? []).map((f) => f.path) : []));
  }, [files]);

  if (!files) return <p className="ws-empty">Changes appear here when the crew finishes a thread.</p>;
  if (files.length === 0) return <p className="ws-empty">This thread didn't change any files.</p>;

  const toggle = (p: string) => {
    const next = new Set(open);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setOpen(next);
  };

  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="diff">
      <div className="diff-summary">
        {files.length} file{files.length === 1 ? "" : "s"}
        <span className="plus">+{adds}</span>
        <span className="minus">−{dels}</span>
      </div>
      {files.map((f) => (
        <section key={f.path} className="diff-file">
          <button className="diff-file-head" onClick={() => toggle(f.path)} aria-expanded={open.has(f.path)}>
            <Icon name={open.has(f.path) ? "chevronDown" : "chevron"} size={13} />
            <span className="truncate">{f.path}</span>
            {CHANGE_LABEL[f.change] && <span className={`diff-tag ${f.change}`}>{CHANGE_LABEL[f.change]}</span>}
            <span className="push-right plus">+{f.additions}</span>
            <span className="minus">−{f.deletions}</span>
          </button>
          {open.has(f.path) &&
            (f.skipped ? (
              <p className="muted pad small">Binary or too large to show.</p>
            ) : (
              <pre className="diff-body">
                {f.hunks.map((h, i) => (
                  <span key={i}>
                    <span className="dl hunk">{h.header}</span>
                    {h.lines.map((l, k) => (
                      <span key={k} className={`dl ${l[0] === "+" ? "add" : l[0] === "-" ? "del" : l[0] === "\\" ? "meta" : ""}`}>
                        {l || " "}
                      </span>
                    ))}
                  </span>
                ))}
              </pre>
            ))}
        </section>
      ))}
    </div>
  );
}
