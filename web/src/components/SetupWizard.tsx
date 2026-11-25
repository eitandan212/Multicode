import { useEffect, useRef, useState } from "react";
import type { ProviderKind, Settings } from "../../../server/shared";
import { api, type AppState } from "../api";
import { AddConnection } from "./ConnectionsDialog";
import { EmojiPicker } from "./EmojiPicker";
import { Icon } from "./Icon";
import { LogoMark } from "./Logo";
import { EXAMPLE_PROMPTS } from "./Tutorial";

const STEPS = ["Welcome", "Connect an AI", "How it works", "First project", "Ready"] as const;

const APPROVALS: { id: Settings["approvals"]; title: string; text: string }[] = [
  { id: "ask", title: "Ask me every time", text: "You approve each change and tool before it happens. Safest." },
  { id: "edits", title: "Auto-accept edits", text: "File changes go through; other tools still ask." },
  { id: "all", title: "Approve all", text: "The crew never stops to ask. You can still undo any run." },
];

/**
 * First-run setup (once per installation): connect an AI without a terminal, choose how much the
 * crew may do alone, make a first project, and start. Every step can be skipped.
 */
export function SetupWizard(p: {
  state: AppState;
  onReload: () => Promise<void>;
  onProject: (name: string) => void;
  onPrompt: (text: string) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ProviderKind>("claude-cli");
  const [approvals, setApprovals] = useState<Settings["approvals"]>(p.state.settings.approvals ?? "ask");
  const [name, setName] = useState("my-first-app");
  const [emoji, setEmoji] = useState<string | undefined>("🚀");
  const [picking, setPicking] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const finish = async () => {
    await api.saveSettings({ onboarded: true }).catch(() => {});
    ref.current?.close();
    p.onDone();
  };
  const next = () => {
    setError("");
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      next();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clean = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  const connected = p.state.connections.length > 0;

  return (
    <dialog ref={ref} className="setup" onCancel={(e) => e.preventDefault()} aria-label="Set up MultiCode">
      <aside className="setup-steps">
        <LogoMark size={28} />
        <ol>
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "is-current" : i < step ? "is-done" : ""}>
              <span className="setup-dot">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <button className="link small setup-skip" onClick={() => void finish()}>
          Skip setup
        </button>
      </aside>

      <section className="setup-body">
        {step === 0 && (
          <div className="setup-page">
            <LogoMark size={56} />
            <h1>Welcome to MultiCode</h1>
            <p className="muted">
              A crew of AI engineers from different companies that plans, builds and reviews your projects
              together. Setup takes about a minute; nothing here needs a terminal.
            </p>
            <ul className="setup-points">
              <li><Icon name="users" size={16} /> Several models work as one team: one plans, others build in parallel, another reviews.</li>
              <li><Icon name="shield" size={16} /> You decide what they may do, and every run can be undone.</li>
              <li><Icon name="moon" size={16} /> Sleep mode: give it work at night, find it done in the morning.</li>
            </ul>
            <div className="setup-actions">
              <button className="btn primary" onClick={next} autoFocus>
                Let's start
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="setup-page">
            <h2>Connect an AI</h2>
            <p className="muted">
              Use a subscription you already have (sign in with one click), any API with a key, or a free
              open-source agent. You can add more later in Settings.
            </p>
            {connected && (
              <p className="setup-connected">
                <Icon name="check" size={14} className="tool-done" /> Connected:{" "}
                {p.state.connections.map((c) => c.label).join(", ")}
              </p>
            )}
            <AddConnection
              kind={kind}
              state={p.state}
              onKind={setKind}
              onSaved={p.onReload}
              onRefresh={p.onReload}
            />
            <div className="setup-actions">
              <button className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button className={`btn ${connected ? "primary" : ""}`} onClick={next}>
                {connected ? "Continue" : "Do this later"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="setup-page">
            <h2>How much may the crew do alone?</h2>
            <p className="muted">Like Claude Code: you can change this any time from the shield next to Send.</p>
            <div className="setup-choices" role="radiogroup">
              {APPROVALS.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={approvals === a.id}
                  className={`setup-choice ${approvals === a.id ? "is-active" : ""}`}
                  onClick={() => setApprovals(a.id)}
                >
                  <strong>{a.title}</strong>
                  <span className="muted">{a.text}</span>
                </button>
              ))}
            </div>
            <div className="setup-note">
              <Icon name="moon" size={16} />
              <span>
                <strong>Sleep mode</strong> (the moon next to Send): the crew works alone, approves its own
                actions, keeps the computer awake, and runs queued tasks one after another.
              </span>
            </div>
            <div className="setup-actions">
              <button className="btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void act(() => api.saveSettings({ approvals }).then(p.onReload))}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="setup-page">
            <h2>Your first project</h2>
            <p className="muted">Start something new, or let the crew work on a folder you already have.</p>
            <div className="setup-project">
              <label className="field">
                <span>New project</span>
                <div className="row-input">
                  <button
                    type="button"
                    className="emoji-choose"
                    onClick={() => setPicking(!picking)}
                    aria-label="Choose an emoji"
                  >
                    {emoji ?? <Icon name="smile" size={16} />}
                  </button>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
                  <button
                    className="btn primary"
                    disabled={!clean || busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await api.createProject(clean);
                        if (emoji) await api.setProjectEmoji(r.name, emoji).catch(() => {});
                        await p.onReload();
                        p.onProject(r.name);
                      })
                    }
                  >
                    Create
                  </button>
                </div>
              </label>
              {picking && (
                <EmojiPicker value={emoji} onPick={(e) => setEmoji(e ?? undefined)} onClose={() => setPicking(false)} />
              )}
              <div className="setup-or">or</div>
              <label className="field">
                <span>Open a folder</span>
                <div className="row-input">
                  <input
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder={navigator.platform.startsWith("Win") ? "C:\\Users\\you\\code\\my-app" : "/Users/you/code/my-app"}
                    spellCheck={false}
                  />
                  {window.multicodeDesktop?.pickFolder && (
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const f = await window.multicodeDesktop!.pickFolder!();
                        if (f) setFolder(f);
                      }}
                    >
                      Browse…
                    </button>
                  )}
                  <button
                    className="btn"
                    disabled={!folder.trim() || busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await api.openFolder(folder.trim());
                        await p.onReload();
                        p.onProject(r.name);
                      })
                    }
                  >
                    Open
                  </button>
                </div>
              </label>
            </div>
            <div className="setup-actions">
              <button className="btn ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <button className="btn" onClick={next}>
                Do this later
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="setup-page">
            <h2>You're ready</h2>
            <p className="muted">
              Tell the crew what to build, in your own words. Pick an idea to start with, or close this and
              write your own.
            </p>
            <div className="suggestions setup-ideas">
              {EXAMPLE_PROMPTS.map((ex) => (
                <button
                  key={ex}
                  className="suggestion"
                  onClick={() => {
                    p.onPrompt(ex);
                    void finish();
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="setup-actions">
              <button className="btn primary" onClick={() => void finish()} autoFocus>
                Start using MultiCode
              </button>
            </div>
          </div>
        )}
        {error && <p className="err-text setup-error">{error}</p>}
      </section>
    </dialog>
  );
}
