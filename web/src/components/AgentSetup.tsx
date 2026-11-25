import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type AgentAccess, type SignInFlow } from "../api";
import { Icon, Spinner } from "./Icon";

const NAMES = { "claude-cli": "Claude Code", "codex-cli": "Codex", antigravity: "Antigravity" } as const;
export type SignInKind = keyof typeof NAMES;
export const canSignIn = (kind: string): kind is SignInKind => kind in NAMES;

/**
 * Install, sign in, and who you're signed in as, for a subscription agent (as in T3 Code).
 * No terminal: the sign-in page opens in your browser and the app notices when you're done.
 */
export function AgentSetup({ kind, onReady }: { kind: SignInKind; onReady?: () => void }) {
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [busy, setBusy] = useState<"" | "install" | "check">("");
  const [error, setError] = useState("");
  const [signing, setSigning] = useState(false);

  const check = useCallback(async () => {
    setBusy("check");
    try {
      setAccess(await api.agentAccess(kind));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, [kind]);
  useEffect(() => {
    void check();
  }, [check]);

  const install = async () => {
    setBusy("install");
    setError("");
    try {
      const r = await api.installAgent(kind);
      if (!r.ok) setError(`Install failed:\n${r.output}`);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
    await check();
  };

  const name = NAMES[kind];
  return (
    <div className={`agent-setup ${access?.signedIn ? "is-ok" : ""}`}>
      {!access ? (
        <span className="muted small">
          <Spinner /> Checking {name}…
        </span>
      ) : !access.installed ? (
        <>
          <span>
            <strong>{name} isn't installed.</strong>{" "}
            <span className="muted">One click installs it for you.</span>
          </span>
          <button type="button" className="btn primary" onClick={install} disabled={busy !== ""}>
            {busy === "install" ? (
              <>
                <Spinner /> Installing…
              </>
            ) : (
              <>
                <Icon name="download" size={14} /> Install
              </>
            )}
          </button>
        </>
      ) : access.signedIn ? (
        <>
          <span>
            <Icon name="check" size={14} className="tool-done" /> Signed in
            {access.account ? <span className="muted"> as {access.account}</span> : null}
          </span>
          <button type="button" className="btn" onClick={() => setSigning(true)}>
            Switch account
          </button>
        </>
      ) : (
        <>
          <span>
            <strong>Sign in to {name}</strong>{" "}
            <span className="muted">to use your subscription.</span>
            {access.problem && <span className="muted small"> ({access.problem})</span>}
          </span>
          <button type="button" className="btn primary" onClick={() => setSigning(true)}>
            Sign in
          </button>
        </>
      )}
      {error && <pre className="err-text small agent-error">{error}</pre>}
      {signing && (
        <SignInDialog
          kind={kind}
          onClose={async (done) => {
            setSigning(false);
            await check();
            if (done) onReady?.();
          }}
        />
      )}
    </div>
  );
}

/** The sign-in itself: opens the provider's page, waits, and takes a code if one is shown. */
export function SignInDialog({
  kind,
  onClose,
}: {
  kind: SignInKind;
  onClose: (done: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [flow, setFlow] = useState<SignInFlow | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const opened = useRef(false);

  useEffect(() => {
    ref.current?.showModal();
    let live = true;
    let timer = 0;
    let id = "";
    const poll = async () => {
      try {
        const f = await api.signInFlow(id);
        if (!live) return;
        setFlow(f);
        if (f.url && !opened.current) {
          opened.current = true;
          window.open(f.url, "_blank", "noopener");
        }
        if (f.state === "waiting") timer = window.setTimeout(poll, 1500);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    api
      .startSignIn(kind)
      .then((f) => {
        if (!live) return;
        id = f.id;
        setFlow(f);
        void poll();
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind]);

  const name = NAMES[kind];
  const done = flow?.state === "done";
  const close = () => {
    if (flow?.state === "waiting") void api.cancelSignIn(flow.id).catch(() => {});
    ref.current?.close();
    onClose(done);
  };

  // Rendered at the top of the page: inside a settings form, its own form would submit both.
  return createPortal(
    <dialog ref={ref} className="dialog signin-dialog" onCancel={(e) => (e.preventDefault(), close())}>
      <header className="dialog-head">
        <div>
          <h2>Sign in to {name}</h2>
          <p className="muted">Your subscription stays yours: MultiCode only runs {name} on this computer.</p>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>
      <div className="dialog-body signin-body">
        {error ? (
          <p className="err-text">{error}</p>
        ) : !flow ? (
          <p className="muted">
            <Spinner /> Starting…
          </p>
        ) : done ? (
          <p className="signin-done">
            <Icon name="check" size={18} className="tool-done" /> You're signed in. {name} is ready.
          </p>
        ) : flow.state === "error" ? (
          <p className="err-text">{flow.message ?? "Sign-in didn't finish."}</p>
        ) : (
          <>
            <ol className="signin-steps">
              <li>Finish signing in on the page that opened in your browser.</li>
              <li>Come back here. This window updates by itself.</li>
            </ol>
            {flow.url && (
              <a className="btn" href={flow.url} target="_blank" rel="noreferrer noopener">
                <Icon name="external" size={14} /> Open the sign-in page again
              </a>
            )}
            {flow.wantsCode && (
              <form
                className="signin-code"
                onSubmit={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (code.trim())
                    void api.signInCode(flow.id, code.trim()).catch((err: Error) => setError(err.message));
                }}
              >
                <label>
                  Got a code on the page? Paste it here
                  <input value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoComplete="off" />
                </label>
                <button className="btn primary" disabled={!code.trim()}>
                  Continue
                </button>
              </form>
            )}
            <p className="muted small">
              <Spinner /> Waiting for {name}…
            </p>
          </>
        )}
      </div>
      <footer className="dialog-foot">
        <button className={`btn ${done ? "primary" : ""}`} onClick={close}>
          {done ? "Done" : "Cancel"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
