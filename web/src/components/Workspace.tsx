import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

interface Props {
  project: string;
  refreshKey: number;
  changed: string[];
}

export function Workspace({ project, refreshKey, changed }: Props) {
  const [tab, setTab] = useState<"preview" | "files">("preview");
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string } | null>(null);
  const [fileError, setFileError] = useState("");

  useEffect(() => {
    api.files(project).then(setFiles, () => setFiles([]));
  }, [project, refreshKey]);

  useEffect(() => {
    setSelected(null);
    setContent(null);
  }, [project]);

  useEffect(() => {
    if (!selected) return;
    setFileError("");
    api.file(project, selected).then(
      (r) => setContent({ path: selected, text: r.content }),
      (e: Error) => setFileError(e.message),
    );
  }, [project, selected, refreshKey]);

  const hasIndex = files.includes("index.html");
  const previewUrl = `/preview/${project}/?v=${refreshKey}`;
  const changedSet = useMemo(() => new Set(changed), [changed]);

  return (
    <section className="workspace" aria-label="Workspace">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "is-active" : ""} onClick={() => setTab("preview")}>
          Preview
        </button>
        <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}>
          Files <span className="count">{files.length}</span>
        </button>
        {tab === "preview" && hasIndex && (
          <a className="btn small ghost push-right" href={previewUrl} target="_blank" rel="noreferrer">
            Open in new tab
          </a>
        )}
      </div>

      {tab === "preview" &&
        (hasIndex ? (
          <iframe
            key={refreshKey}
            className="preview"
            title="Project preview"
            src={previewUrl}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
          />
        ) : (
          <div className="ws-empty">
            <p>
              {files.length
                ? "There's no index.html to preview. Browse the code in Files."
                : "The preview appears here once the crew writes index.html."}
            </p>
          </div>
        ))}

      {tab === "files" && (
        <div className="files">
          <ul className="tree">
            {files.length === 0 && <li className="muted small">No files yet.</li>}
            {files.map((f) => (
              <li key={f}>
                <button className={`${selected === f ? "is-active" : ""}`} onClick={() => setSelected(f)} title={f}>
                  <span className="path">{f}</span>
                  {changedSet.has(f) && <span className="changed-dot" aria-label="changed in this run" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="code-view">
            {fileError && <p className="err-text">{fileError}</p>}
            {!content && !fileError && <p className="muted ws-hint">Pick a file to read it.</p>}
            {content && (
              <>
                <div className="code-path">{content.path}</div>
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
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
