import { useEffect, useState } from "react";
import { Icon, Spinner } from "./Icon";

const EVERY = 6 * 60 * 60_000;

/**
 * The desktop app's update button: shown only when a newer MultiCode exists. One click downloads
 * it, checks its checksum, installs it silently and reopens MultiCode.
 */
export function UpdateButton() {
  const updater = window.multicodeDesktop?.update;
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!updater) return;
    let live = true;
    const check = () =>
      void updater
        .check()
        .then((r) => live && r?.available && setVersion(r.version ?? null))
        .catch(() => {});
    check();
    const t = window.setInterval(check, EVERY);
    const off = updater.onProgress((p) => live && setProgress(p));
    return () => {
      live = false;
      clearInterval(t);
      off();
    };
  }, [updater]);

  if (!updater || !version) return null;
  const busy = progress !== null && !error;
  return (
    <div className="update-box" role="status">
      <div className="update-text">
        <strong>Update available</strong>
        <span className="muted small">
          {error
            ? error
            : busy
              ? progress! < 1
                ? `Downloading… ${Math.round(progress! * 100)}%`
                : "Installing… MultiCode will reopen"
              : `MultiCode ${version} is ready to install`}
        </span>
        {busy && (
          <span className="update-bar">
            <span style={{ width: `${Math.round(progress! * 100)}%` }} />
          </span>
        )}
      </div>
      <button
        className="btn primary small"
        disabled={busy}
        onClick={() => {
          setError("");
          setProgress(0);
          updater.install().catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
        }}
      >
        {busy ? <Spinner /> : <Icon name="download" size={14} />} {error ? "Try again" : "Update"}
      </button>
    </div>
  );
}
