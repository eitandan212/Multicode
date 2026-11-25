import { useEffect, useRef } from "react";
import {
  ACCENTS,
  DEFAULT_APPEARANCE,
  FONTS,
  type Appearance,
  type FontChoice,
  type SizeChoice,
  type ThemeMode,
} from "../appearance";
import { useOpenDialog } from "./embed";
import { Icon } from "./Icon";

interface Props {
  value: Appearance;
  onChange: (a: Appearance) => void;
  onReplayIntro: () => void;
  onClose: () => void;
}

/** Personal look and feel. Every change applies immediately. */
export function AppearanceDialog({
  value: a,
  onChange,
  onReplayIntro,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  useEffect(() => {
    openDialog(ref.current);
  }, []);
  const set = (patch: Partial<Appearance>) => onChange({ ...a, ...patch });
  const customAccent =
    a.accent !== null && !ACCENTS.some((x) => x.value === a.accent);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <div>
          <h2>Appearance</h2>
          <p className="muted">Make MultiCode yours. Saved in this browser.</p>
        </div>
        <button
          className="icon-btn"
          onClick={() => ref.current?.close()}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </header>

      <div className="dialog-body appearance">
        <Row label="Theme">
          <Seg<ThemeMode>
            value={a.theme}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
            onChange={(theme) => set({ theme })}
          />
        </Row>

        <Row label="Accent">
          <div
            className="swatches"
            role="radiogroup"
            aria-label="Accent colour"
          >
            {ACCENTS.map((x) => (
              <button
                key={x.name}
                role="radio"
                aria-checked={a.accent === x.value}
                aria-label={x.name}
                title={x.name}
                className={`swatch ${a.accent === x.value ? "is-on" : ""}`}
                style={{ background: x.swatch }}
                onClick={() => set({ accent: x.value })}
              />
            ))}
            <label
              className={`swatch custom ${customAccent ? "is-on" : ""}`}
              title="Custom colour"
              style={customAccent ? { background: a.accent! } : undefined}
            >
              <input
                type="color"
                aria-label="Custom accent colour"
                value={a.accent ?? "#3d8c66"}
                onChange={(e) => set({ accent: e.target.value })}
              />
              {!customAccent && <Icon name="spark" size={14} />}
            </label>
          </div>
        </Row>

        <Row label="Font">
          <Seg<FontChoice>
            value={a.font}
            options={(Object.keys(FONTS) as FontChoice[]).map((k) => [
              k,
              FONTS[k].label,
            ])}
            onChange={(font) => set({ font })}
            fontPreview
          />
        </Row>

        <Row label="Size">
          <Seg<SizeChoice>
            value={a.size}
            options={[
              ["compact", "Compact"],
              ["default", "Default"],
              ["large", "Large"],
            ]}
            onChange={(size) => set({ size })}
          />
        </Row>

        <Row label="Motion">
          <Toggle
            checked={!a.reducedMotion}
            onChange={(on) => set({ reducedMotion: !on })}
            text="Animations"
          />
        </Row>
        <Row label="Intro">
          <Toggle
            checked={a.intro}
            onChange={(intro) => set({ intro })}
            text="Play the opening animation"
          />
          <button className="btn small ghost" onClick={onReplayIntro}>
            Replay
          </button>
        </Row>

        <div className="form-actions">
          <button
            className="btn ghost"
            onClick={() => onChange(DEFAULT_APPEARANCE)}
          >
            Reset to default
          </button>
          <button className="btn primary" onClick={() => ref.current?.close()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ap-row">
      <span className="ap-label">{label}</span>
      <div className="ap-control">{children}</div>
    </div>
  );
}

function Seg<T extends string>(p: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  fontPreview?: boolean;
}) {
  return (
    <div className="seg mini" role="radiogroup">
      {p.options.map(([v, label]) => (
        <button
          key={v}
          role="radio"
          aria-checked={p.value === v}
          className={p.value === v ? "is-active" : ""}
          style={
            p.fontPreview
              ? { fontFamily: FONTS[v as FontChoice].stack }
              : undefined
          }
          onClick={() => p.onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  text,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  text: string;
}) {
  return (
    <label className="ap-toggle">
      <button
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      {text}
    </label>
  );
}
