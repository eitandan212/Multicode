import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./Icon";

const CHOICES = [
  "🚀", "⚡", "🔥", "✨", "💡", "🎯", "🧠", "🤖", "🛠️", "⚙️", "🧪", "🔒",
  "🌐", "📱", "💻", "🖥️", "🎮", "🕹️", "🎨", "🖌️", "📷", "🎵", "🎬", "📚",
  "📝", "📊", "📈", "💰", "🛒", "🏪", "🍕", "☕", "🍔", "🌮", "🍰", "🍎",
  "🐶", "🐱", "🦊", "🐼", "🐙", "🦄", "🌱", "🌳", "🌊", "☀️", "🌙", "⭐",
  "❤️", "💜", "💙", "💚", "🧡", "💛", "🏠", "🏫", "🏥", "✈️", "🚗", "⚽",
];

/** Pick a project's emoji: a few common ones, or type/paste any (Windows: Win + .). */
export function EmojiPicker(p: {
  value?: string;
  onPick: (emoji: string | null) => Promise<void> | void;
  onClose: () => void;
  /** Where to float it (fixed position); omitted, it sits in the flow. */
  style?: CSSProperties;
}) {
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = p;
  // Escape or a click elsewhere closes it.
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener("pointerdown", close);
      document.addEventListener("keydown", close);
    });
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [onClose]);
  const [error, setError] = useState("");
  const pick = async (e: string | null) => {
    setError("");
    try {
      await p.onPick(e);
      p.onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div ref={ref} className="emoji-picker" role="dialog" aria-label="Project emoji" style={p.style}>
      <div className="emoji-grid">
        {CHOICES.map((e) => (
          <button
            key={e}
            type="button"
            className={`emoji-cell ${p.value === e ? "is-active" : ""}`}
            onClick={() => void pick(e)}
            aria-label={e}
          >
            {e}
          </button>
        ))}
      </div>
      <form
        className="emoji-own"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (custom.trim()) void pick(custom.trim());
        }}
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Any emoji…"
          aria-label="Type or paste an emoji"
          maxLength={32}
        />
        <button className="btn small" disabled={!custom.trim()}>
          Use
        </button>
      </form>
      {error && <p className="err-text small">{error}</p>}
      <div className="emoji-foot">
        {p.value && (
          <button type="button" className="btn small" onClick={() => void pick(null)}>
            <Icon name="x" size={12} /> Remove emoji
          </button>
        )}
        <button type="button" className="btn small push-right" onClick={p.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
