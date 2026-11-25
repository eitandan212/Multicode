import { useEffect, useRef, useState } from "react";
import type {
  ExtensionsView,
  PluginInfo,
  SkillMode,
} from "../../../server/shared";
import { api } from "../api";
import { useOpenDialog } from "./embed";
import { Icon, type IconName } from "./Icon";

const CATEGORY_ICON: Record<PluginInfo["category"], IconName> = {
  memory: "graph",
  browser: "globe",
  knowledge: "book",
  reasoning: "spark",
  computer: "monitor",
};

const RISK_TEXT: Record<PluginInfo["risk"], string> = {
  low: "Safe",
  medium: "Uses the web",
  high: "Controls this computer",
};

/**
 * Plugins (MCP servers wired into every harness) and skill packs (SKILL.md folders every
 * harness loads). Auto skill packs are picked per request from what you ask and what the
 * project contains.
 */
export function ExtensionsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  const [view, setView] = useState<ExtensionsView | null>(null);
  const [confirming, setConfirming] = useState<PluginInfo | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    openDialog(ref.current);
    api.extensions().then(setView, (e: Error) => setError(e.message));
  }, []);

  const save = async (body: Record<string, unknown>) => {
    setError("");
    try {
      setView(await api.saveExtensions(body));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = (p: PluginInfo) => {
    if (!p.enabled && p.risk === "high") {
      setUnderstood(false);
      setConfirming(p);
      return;
    }
    void save({ plugin: { id: p.id, enabled: !p.enabled } });
  };

  return (
    <dialog
      ref={ref}
      className="dialog ext-dialog"
      onClose={onClose}
      onCancel={onClose}
    >
      <header className="dialog-head">
        <div>
          <h2>Plugins & skills</h2>
          <p className="muted">
            Turned-on plugins and skills reach every harness automatically:
            Claude Code, Codex, Gemini CLI, Qwen Code and OpenCode.
          </p>
        </div>
        <button
          className="icon-btn"
          onClick={() => ref.current?.close()}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </header>

      <div className="dialog-body">
        {!view && !error && <p className="muted">Loading…</p>}
        {view && (
          <>
            <section className="ext-section">
              <h3>Plugins</h3>
              <ul className="ext-list">
                {view.plugins.map((p) => (
                  <li
                    key={p.id}
                    className={`ext-card ${p.enabled ? "is-on" : ""}`}
                  >
                    <span className={`ext-icon risk-${p.risk}`}>
                      <Icon name={CATEGORY_ICON[p.category]} />
                    </span>
                    <div className="ext-main">
                      <div className="ext-title">
                        <b>{p.name}</b>
                        <span className={`risk-tag risk-${p.risk}`}>
                          {RISK_TEXT[p.risk]}
                        </span>
                      </div>
                      <p className="muted small">{p.description}</p>
                      <span className="ext-source">{p.source}</span>
                      {p.enabled && p.id === "browser" && (
                        <label className="ext-option">
                          <input
                            type="checkbox"
                            checked={view.browserAnyWebsite}
                            onChange={(e) =>
                              save({ browserAnyWebsite: e.target.checked })
                            }
                          />
                          Allow any website (otherwise only the MultiCode
                          preview)
                        </label>
                      )}
                      {p.enabled &&
                        p.optionalEnv?.map((n) => (
                          <label key={n} className="ext-option env-row">
                            <code>{n}</code>
                            <input
                              type="password"
                              autoComplete="off"
                              placeholder="Optional key"
                              value={keys[n] ?? ""}
                              onChange={(e) =>
                                setKeys({ ...keys, [n]: e.target.value })
                              }
                              onBlur={() =>
                                keys[n] &&
                                api
                                  .saveSync({ env: { [n]: keys[n]! } })
                                  .then(() => setKeys({ ...keys, [n]: "" }))
                              }
                            />
                          </label>
                        ))}
                    </div>
                    <button
                      role="switch"
                      aria-checked={p.enabled}
                      aria-label={`${p.enabled ? "Turn off" : "Turn on"} ${p.name}`}
                      className={`switch ${p.enabled ? "on" : ""}`}
                      onClick={() => toggle(p)}
                    >
                      <span />
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="ext-section">
              <h3>Skill packs</h3>
              <p className="muted small">
                Auto turns a pack on when your request or the project needs it.
                Skills are written to <code>.claude/skills</code>,{" "}
                <code>.agents/skills</code>, <code>.gemini/skills</code> and{" "}
                <code>.qwen/skills</code>, and given to API agents directly.
              </p>
              <ul className="ext-list">
                {view.packs.map((pk) => (
                  <li
                    key={pk.id}
                    className={`ext-card ${pk.mode !== "off" ? "is-on" : ""}`}
                  >
                    <span className="ext-icon">
                      <Icon name="book" />
                    </span>
                    <div className="ext-main">
                      <div className="ext-title">
                        <b>{pk.name}</b>
                      </div>
                      <p className="muted small">{pk.description}</p>
                      <div className="skill-chips">
                        {pk.skills.map((s) => (
                          <span
                            key={s.name}
                            className="skill-chip"
                            title={s.description}
                          >
                            {s.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div
                      className="seg mini"
                      role="radiogroup"
                      aria-label={`${pk.name} mode`}
                    >
                      {(["auto", "on", "off"] as SkillMode[]).map((m) => (
                        <button
                          key={m}
                          role="radio"
                          aria-checked={pk.mode === m}
                          className={pk.mode === m ? "is-active" : ""}
                          onClick={() => save({ pack: { id: pk.id, mode: m } })}
                        >
                          {m === "auto" ? "Auto" : m === "on" ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
        {error && <p className="err-text">{error}</p>}
      </div>

      {confirming && (
        <div
          className="confirm-layer"
          role="alertdialog"
          aria-labelledby="risk-title"
        >
          <div className="confirm-box">
            <h3 id="risk-title">Turn on {confirming.name}?</h3>
            <p>{confirming.description}</p>
            <p className="muted small">
              Agents act on their own. Only turn this on for work you supervise,
              and turn it off when you're done.
            </p>
            <label className="ext-option">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
              />
              I understand agents can control this computer
            </label>
            <div className="form-actions">
              <button className="btn ghost" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                className="btn danger-solid"
                disabled={!understood}
                onClick={async () => {
                  await save({
                    plugin: {
                      id: confirming.id,
                      enabled: true,
                      confirmRisk: true,
                    },
                  });
                  setConfirming(null);
                }}
              >
                Turn on
              </button>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
