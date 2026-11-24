import { useId } from "react";

/**
 * The MultiCode mark: an M folded like a ribbon between code brackets.
 * Same artwork as assets/brand/logo.svg, with ids scoped per instance.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="0 0 120 80" width={size * 1.5} height={size} aria-hidden>
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-stem-top)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-stem-bottom)" }} />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-fold-top)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-fold-bottom)" }} />
        </linearGradient>
      </defs>
      <path className="lm-bracket lm-left" d="M22 27 L9 40 L22 53" fill="none" stroke="var(--logo-bracket)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path className="lm-bracket lm-right" d="M98 27 L111 40 L98 53" fill="none" stroke="var(--logo-bracket)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <g className="lm-m">
        <path d="M44 13 L60 39 L60 56 L44 30 Z" fill={`url(#${id}f)`} />
        <path d="M76 13 L60 39 L60 56 L76 30 Z" fill={`url(#${id}f)`} opacity="0.85" />
        <path d="M31 19 Q31 15 34.5 13.3 L44 9 L44 67 L31 67 Z" fill={`url(#${id}s)`} />
        <path d="M89 19 Q89 15 85.5 13.3 L76 9 L76 67 L89 67 Z" fill={`url(#${id}s)`} />
      </g>
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
