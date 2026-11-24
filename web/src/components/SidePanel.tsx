import { useEffect, useMemo, useState } from "react";
import type { ConnectionView, CrewMember, FileDiff } from "../../../server/shared";
import { api } from "../api";
import { colorFor, ROLE_LABEL, VENDOR } from "../crewColors";
import { DiffView } from "./DiffView";
import { Icon, Spinner } from "./Icon";

export type PanelTab = "preview" | "files" | "changes";

interface Props {
  project: string;
  crew: CrewMember[];
  connections: ConnectionView[];
  busy: Set<string>;
  refreshKey: number;
  changed: string[];
  diff: FileDiff[] | undefined;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onOpenCrew: () => void;
  onOpenConnections: () => void;
}

export function SidePanel(p: Props) {
  const { tab, onTab: setTab } = p;
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string } | null>(null);
  const [fileError, setFileError] = useState("");
  const changedSet = useMemo(() => new Set(p.changed), [p.changed]);

  useEffect(() => {
    api.files(p.project).then(setFiles, () => setFiles([]));
  }, [p.project, p.refreshKey]);

  useEffect(() => {
    setSelected(null);
    setContent(null);
  }, [p.project]);

  useEffect(() => {
    if (!selected) return;
    setFileError("");
    api.file(p.project, selected).then(
      (r) => setContent({ path: selected, text: r.content }),
      (e: Error) => setFileError(e.message),
    );
  }, [p.project, selected, p.refreshKey]);

  const hasIndex = files.includes("index.html");
  const previewUrl = `/preview/${p.project}/?v=${p.refreshKey}`;
  const conn = (id: string) => p.connections.find((c) => c.id === id);

  return (
    <aside className="side" aria-label="Crew and workspace">
      <section className="card crew-card">
        {p.crew.length === 0 ? (
          <button className="card-row" onClick={p.onOpenConnections}>
            <Icon name="plug" />
            <span>Connect an AI to form a crew</span>
          </button>
        ) : (
          p.crew.map((m) => {
            const c = conn(m.connectionId);
            return (
              <div key={m.id} className="card-row member-row" style={{ ["--agent" as string]: colorFor(p.crew, m.id) }}>
                <span className="member-dot" />
                <span className="member-name truncate">{m.name}</span>
                <span className="muted truncate member-meta">
                  {ROLE_LABEL[m.role]} · {c ? VENDOR[c.kind] : "missing"}
                </span>
                {p.busy.has(m.id) && <Spinner size={11} />}
              </div>
            );
          })
        )}
        <div className="card-sep" />
        <button className="card-row" onClick={p.onOpenCrew}>
          <Icon name="users" />
          <span>Edit crew</span>
          <Icon name="chevron" size={14} className="push-right" />
        </button>
        <button className="card-row" onClick={p.onOpenConnections}>
          <Icon name="plug" />
          <span>Connections</span>
          <span className="muted push-right">{p.connections.length}</span>
        </button>
      </section>

      <section className="card ws-card">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "is-active" : ""} onClick={() => setTab("preview")}>
            <Icon name="globe" size={14} /> Preview
          </button>
          <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}>
            <Icon name="file" size={14} /> Files <span className="muted">{files.length}</span>
          </button>
          <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "is-active" : ""} onClick={() => setTab("changes")}>
            <Icon name="list" size={14} /> Changes {p.diff && p.diff.length > 0 && <span className="muted">{p.diff.length}</span>}
          </button>
          {tab === "preview" && hasIndex && (
            <a className="icon-btn push-right" href={previewUrl} target="_blank" rel="noreferrer" title="Open in new tab" aria-label="Open preview in new tab">
              <Icon name="external" size={14} />
            </a>
          )}
        </div>

        {tab === "preview" &&
          (hasIndex ? (
            <iframe key={p.refreshKey} className="preview" title="Project preview" src={previewUrl} sandbox="allow-scripts allow-forms allow-modals allow-popups" />
          ) : (
            <p className="ws-empty">{files.length ? "No index.html to preview. Browse the code in Files." : "The preview appears once the crew writes index.html."}</p>
          ))}

        {tab === "changes" && <DiffView files={p.diff} />}

        {tab === "files" && (
          <div className="files">
            <ul className="tree">
              {files.length === 0 && <li className="muted small pad">No files yet.</li>}
              {files.map((f) => (
                <li key={f}>
                  <button className={selected === f ? "is-active" : ""} onClick={() => setSelected(f)} title={f}>
                    <span className="truncate">{f}</span>
                    {changedSet.has(f) && <span className="changed-dot" aria-label="changed in this thread" />}
                  </button>
                </li>
              ))}
            </ul>
            <div className="code-view">
              {fileError && <p className="err-text pad">{fileError}</p>}
              {!content && !fileError && <p className="muted pad">Pick a file to read it.</p>}
              {content && (
                <pre className="code">
                  {content.text.split("\n").map((line, i) => (
                    <span key={i} className="line">
                      <span className="ln" aria-hidden>
                        {i + 1}
                      </span>
                      {line || " "}
                    </span>
                  ))}
                </pre>
              )}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}
