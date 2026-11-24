/**
 * Decorative ribbons behind the start screen. Three soft bands draw themselves in once on
 * load (the page's single orchestrated motion); reduced-motion users see them static.
 */
export function Ribbons() {
  return (
    <svg className="ribbons" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <path className="ribbon r1" pathLength={1} d="M-120 690 C 220 560, 380 820, 640 640 S 1040 420, 1340 520" />
      <path className="ribbon r2" pathLength={1} d="M-80 150 C 160 260, 300 40, 560 130 S 980 320, 1300 120" />
      <path className="ribbon r3" pathLength={1} d="M860 -60 C 760 180, 1040 300, 960 560 S 1080 820, 1240 900" />
    </svg>
  );
}
