import { useState } from "react";
import { Icon } from "./Icon";
import { LogoMark } from "./Logo";

export const EXAMPLE_PROMPTS = [
  "A landing page for a coffee shop with a menu and opening hours",
  "A to-do app with drag-and-drop and dark mode",
  "A snake game in the browser with a high-score table",
];

interface Props {
  hasConnection: boolean;
  crewSize: number;
  hasProject: boolean;
  hasRun: boolean;
  onConnect: () => void;
  onEditCrew: () => void;
  onCreateProject: (name: string) => Promise<void>;
  onExample: (prompt: string) => void;
  onSkip: () => void;
}

type StepState = "done" | "current" | "todo";

/**
 * First-run guide: connect an AI, meet the crew, name a project, ask for something.
 * Each step completes from the app's real state, so the guide never gets out of sync.
 */
export function Tutorial(p: Props) {
  const steps: StepState[] = [];
  const done = [
    p.hasConnection,
    p.hasConnection && p.crewSize > 0,
    p.hasProject,
    p.hasRun,
  ];
  let current = done.indexOf(false);
  if (current < 0) current = done.length;
  done.forEach((d, i) =>
    steps.push(d ? "done" : i === current ? "current" : "todo"),
  );

  return (
    <section className="tutorial" aria-label="Getting started">
      <LogoMark size={40} className="hero-mark" />
      <h1>Welcome to MultiCode</h1>
      <p className="muted">
        Four steps and your AI crew is building. You can skip this at any time.
      </p>

      <ol className="tut-steps">
        <Step
          n={1}
          state={steps[0]!}
          title="Connect an AI"
          text="A subscription you already pay for, an API key, or a free open-source agent."
        >
          <button className="btn primary small" onClick={p.onConnect}>
            <Icon name="plug" size={14} /> Open connections
          </button>
        </Step>
        <Step
          n={2}
          state={steps[1]!}
          title="Meet your crew"
          text={
            p.crewSize > 0
              ? `${p.crewSize} agent${p.crewSize === 1 ? "" : "s"} ready. They plan, build in parallel and review each other.`
              : "Every connection becomes an agent: an architect plans, builders write code, a reviewer checks it."
          }
        >
          <button className="btn small" onClick={p.onEditCrew}>
            <Icon name="users" size={14} /> Edit crew
          </button>
        </Step>
        <Step
          n={3}
          state={steps[2]!}
          title="Name your project"
          text="A folder on this computer where the crew writes the code."
        >
          <ProjectForm onCreate={p.onCreateProject} />
        </Step>
        <Step
          n={4}
          state={steps[3]!}
          title="Ask for something"
          text="Describe it in plain words below, or start from an example."
        >
          <div className="tut-examples">
            {EXAMPLE_PROMPTS.map((ex) => (
              <button
                key={ex}
                className="tut-example"
                onClick={() => p.onExample(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
        </Step>
      </ol>

      <ul className="tut-tips muted small">
        <li>
          <kbd>Ctrl K</kbd> finds any command
        </li>
        <li>
          <Icon name="palette" size={13} /> MultiDesign: several models design,
          you pick
        </li>
        <li>
          <Icon name="shield" size={13} /> Changes can be reviewed or undone
        </li>
      </ul>
      <button className="link small tut-skip" onClick={p.onSkip}>
        Skip the tutorial
      </button>
    </section>
  );
}

function Step(props: {
  n: number;
  state: StepState;
  title: string;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className={`tut-step is-${props.state}`}
      aria-current={props.state === "current" ? "step" : undefined}
    >
      <span className="tut-num" aria-hidden>
        {props.state === "done" ? <Icon name="check" size={13} /> : props.n}
      </span>
      <div className="tut-body">
        <strong>
          {props.title}
          {props.state === "done" && <span className="sr-only"> (done)</span>}
        </strong>
        <span className="muted small">{props.text}</span>
        {props.state === "current" && (
          <div className="tut-action">{props.children}</div>
        )}
      </div>
    </li>
  );
}

export function ProjectForm({
  onCreate,
}: {
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return (
    <form
      className="tut-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!clean) return;
        setBusy(true);
        setError("");
        try {
          await onCreate(clean);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. coffee-shop"
        maxLength={60}
        aria-label="Project name"
        autoFocus
      />
      <button className="btn primary small" disabled={!clean || busy}>
        {busy ? "Creating…" : "Create"}
      </button>
      {name && clean !== name.trim() && (
        <span className="muted small">Saved as {clean || "…"}</span>
      )}
      {error && <span className="err-text small">{error}</span>}
    </form>
  );
}
