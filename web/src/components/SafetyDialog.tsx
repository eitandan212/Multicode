import { useEffect, useRef, useState } from "react";
import type { SafetyMode, Settings } from "../../../server/shared";
import { api, type AppState } from "../api";
import { Icon, type IconName } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

const MODES: { id: SafetyMode; icon: IconName; title: string; text: string }[] =
  [
    {
      id: "direct",
      icon: "undo",
      title: "Direct, with undo",
      text: "Agents edit the project. Every thread can be undone, and edits made after it are never overwritten silently.",
    },
    {
      id: "sandbox",
      icon: "shield",
      title: "Sandbox",
      text: "Agents work on a copy without your secrets. Nothing reaches the project until you review the changes and apply them.",
    },
    {
      id: "readonly",
      icon: "book",
      title: "Plan only",
      text: "Agents read and plan but change nothing. Use it to explore an idea or a codebase safely.",
    },
  ];

/** Savings (economy, free fallback, usage limits) and safety (modes, protected files). */
export function SafetyDialog({
  state,
  onClose,
  onChanged,
}: {
  state: AppState;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [s, setS] = useState<Settings>(state.settings);
  const [paths, setPaths] = useState(state.settings.protectedPaths.join("\n"));
  const [error, setError] = useState("");
  const opencode = state.clis.find((c) => c.kind === "opencode-cli");

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const save = async (patch: Partial<Settings>) => {
    setError("");
    try {
      setS(await api.saveSettings(patch));
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const limited = Object.entries(state.limits).filter(
    ([, until]) => until > Date.now(),
  );

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <div>
          <h2>Savings & safety</h2>
          <p className="muted">
            Spend fewer credits, never stall on a usage limit, and decide how
            agents may touch your files.
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
        <section className="ext-section">
          <h3>Savings</h3>
          <div className="ext-card is-on">
            <span className="ext-icon">
              <Icon name="spark" />
            </span>
            <div className="ext-main">
              <b>Economy mode</b>
              <p className="muted small">
                The dispatcher hands work to free and flat-rate members first,
                the cheapest member reviews (one round), and agents get smaller
                context. Typically far fewer paid tokens for the same result.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={s.economy}
              aria-label="Economy mode"
              className={`switch ${s.economy ? "on" : ""}`}
              onClick={() => save({ economy: !s.economy })}
            >
              <span />
            </button>
          </div>

          <div className="ext-card is-on">
            <span className="ext-icon">
              <ProviderLogo kind="opencode-cli" />
            </span>
            <div className="ext-main">
              <b>Free fallback</b>
              <p className="muted small">
                When a subscription or API key hits its usage limit, the free
                model takes over that agent's work right away, so a run never
                stops halfway. The account is skipped until its limit resets.
              </p>
              {s.freeFallback.enabled && (
                <label className="ext-option">
                  Model
                  <input
                    className="inline-input"
                    value={s.freeFallback.model}
                    onChange={(e) =>
                      setS({
                        ...s,
                        freeFallback: {
                          ...s.freeFallback,
                          model: e.target.value,
                        },
                      })
                    }
                    onBlur={() => save({ freeFallback: s.freeFallback })}
                  />
                </label>
              )}
              {!opencode?.installed && (
                <p className="warn-text small">
                  Needs OpenCode: {opencode?.hint}
                </p>
              )}
            </div>
            <button
              role="switch"
              aria-checked={s.freeFallback.enabled}
              aria-label="Free fallback"
              className={`switch ${s.freeFallback.enabled ? "on" : ""}`}
              onClick={() =>
                save({
                  freeFallback: {
                    ...s.freeFallback,
                    enabled: !s.freeFallback.enabled,
                  },
                })
              }
            >
              <span />
            </button>
          </div>

          {limited.length > 0 && (
            <div className="limits">
              {limited.map(([id, until]) => {
                const c = state.connections.find((x) => x.id === id);
                return (
                  <div key={id} className="limit-row">
                    {c && (
                      <ProviderLogo
                        kind={c.kind}
                        acp={c.acp}
                        baseUrl={c.baseUrl}
                        model={c.defaultModel}
                      />
                    )}
                    <span>
                      <b>{c?.label ?? id}</b> reached its limit. Free model
                      until{" "}
                      {new Date(until).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      .
                    </span>
                    <button
                      className="btn small ghost push-right"
                      onClick={async () => {
                        await api.resetLimit(id);
                        await onChanged();
                      }}
                    >
                      Use it again now
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="ext-section">
          <h3>Safety</h3>
          <div
            className="safety-modes"
            role="radiogroup"
            aria-label="How agents may touch files"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={s.safety === m.id}
                className={`safety-card ${s.safety === m.id ? "is-on" : ""}`}
                onClick={() => save({ safety: m.id })}
              >
                <Icon name={m.icon} />
                <b>{m.title}</b>
                <span className="muted small">{m.text}</span>
              </button>
            ))}
          </div>
          <label className="field">
            <span>Protected files (one pattern per line)</span>
            <textarea
              className="area mono"
              rows={4}
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              onBlur={() =>
                save({
                  protectedPaths: paths
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean),
                })
              }
            />
            <small className="muted">
              Never sent to models and never changed: agents' edits to them are
              rolled back, and sandboxes don't contain them. Always on for every
              agent, MultiCode-wide.
            </small>
          </label>
        </section>

        {error && <p className="err-text">{error}</p>}
        <div className="form-actions">
          <button className="btn primary" onClick={() => ref.current?.close()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
