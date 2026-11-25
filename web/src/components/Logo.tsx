/** The MultiCode mark: an isometric M of three ribbons (Cobalt, Off-White, Amber), one per engine. */
export const MARK_PATHS = [
  "M0 34 L53.5 0 L106.5 36 L75 57.5 L40 34 L40 107.5 L0 132.5Z",
  "M75 57.5 L160 0 L160 50 L108.5 81 L108.5 112.5 L75 135Z",
  "M160 0 L199 26 L199 107.5 L137.5 145 L137.5 102.5 L160 86Z",
] as const;

export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 145" width={Math.round((size * 200) / 145)} height={size} aria-hidden>
      <path className="lm-a" d={MARK_PATHS[0]} fill="var(--logo-a)" />
      <path className="lm-b" d={MARK_PATHS[1]} fill="var(--logo-b)" />
      <path className="lm-c" d={MARK_PATHS[2]} fill="var(--logo-c)" />
    </svg>
  );
}

/** Mark + wordmark, as in the secondary lockup. */
export function Lockup({ size = 22 }: { size?: number }) {
  return (
    <span className="lockup">
      <LogoMark size={size} />
      <span className="wordmark">MultiCode</span>
    </span>
  );
}
