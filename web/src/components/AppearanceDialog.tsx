import { useEffect, useRef, useState } from "react";
import {
  ACCENTS,
  BG_PRESETS,
  imageToBackground,
  type RadiusChoice,
  type StatusStyle,
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
  /** Returns false when it couldn't be stored (kept for this session only). */
  onChange: (a: Appearance) => boolean | void;
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
  const [bgError, setBgError] = useState("");
  const set = (patch: Partial<Appearance>) => {
    const ok = onChange({ ...a, ...patch });
    if (ok === false && patch.bgImage) setBgError("This picture is kept until you close MultiCode; it's too large to remember.");
  };
  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setBgError("");
    try {
      set({ background: "image", bgImage: await imageToBackground(file) });
    } catch (e) {
      setBgError(e instanceof Error ? e.message : String(e));
    }
  };
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

        <Row label="Background">
          <div className="bg-picker" role="radiogroup" aria-label="Background">
            <button
              role="radio"
              aria-checked={a.background === "none"}
              className={`bg-choice is-none ${a.background === "none" ? "is-on" : ""}`}
              onClick={() => set({ background: "none" })}
            >
              <span>Plain</span>
            </button>
            {BG_PRESETS.map((b) => (
              <button
                key={b.id}
                role="radio"
                aria-checked={a.background === "preset" && a.bgPreset === b.id}
                className={`bg-choice ${a.background === "preset" && a.bgPreset === b.id ? "is-on" : ""}`}
                style={{ background: b.css.replace(/var\(--bg-solid\)/g, "#888") }}
                onClick={() => set({ background: "preset", bgPreset: b.id })}
              >
                <span>{b.name}</span>
              </button>
            ))}
            <label
              className={`bg-choice ${a.background === "color" ? "is-on" : ""}`}
              style={{ background: a.bgColor }}
              title="Your own colour"
            >
              <input
                type="color"
                aria-label="Background colour"
                value={a.bgColor}
                onChange={(e) => set({ background: "color", bgColor: e.target.value })}
              />
              <span>Colour</span>
            </label>
            <label
              className={`bg-choice ${a.background === "image" ? "is-on" : ""}`}
              style={a.bgImage ? { background: `url("${a.bgImage}") center / cover` } : { background: "linear-gradient(135deg, #64748b, #334155)" }}
              title="Your own picture"
            >
              <input type="file" accept="image/*" aria-label="Background picture" onChange={(e) => void pickImage(e.target.files?.[0])} />
              <span>{a.bgImage ? "Picture" : "Upload…"}</span>
            </label>
          </div>
          {a.background !== "none" && (
            <>
              <label className="ap-range">
                Dim
                <input type="range" min={0} max={90} value={a.bgDim} onChange={(e) => set({ bgDim: Number(e.target.value) })} />
                {a.bgDim}%
              </label>
              <label className="ap-range">
                Blur
                <input type="range" min={0} max={24} value={a.bgBlur} onChange={(e) => set({ bgBlur: Number(e.target.value) })} />
                {a.bgBlur}px
              </label>
            </>
          )}
          {bgError && <p className="err-text small">{bgError}</p>}
        </Row>

        <Row label="Corners">
          <Seg<RadiusChoice>
            value={a.radius}
            options={[
              ["sharp", "Sharp"],
              ["default", "Default"],
              ["round", "Round"],
            ]}
            onChange={(radius) => set({ radius })}
          />
        </Row>

        <Row label="Status marks">
          <Seg<StatusStyle>
            value={a.statusStyle}
            options={[
              ["dots", "Dots"],
              ["emoji", "Emoji"],
              ["symbols", "Symbols"],
            ]}
            onChange={(statusStyle) => set({ statusStyle })}
          />
          <span className="status-preview" aria-hidden>
            <span className="sb-dot is-attention" /> waiting
            <span className="sb-dot is-bad" /> failed
          </span>
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

export function Row({
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

export function Seg<T extends string>(p: {
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

export function Toggle({
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
