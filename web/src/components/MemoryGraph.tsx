import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon, Spinner } from "./Icon";

interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}
interface Relation {
  from: string;
  to: string;
  relationType: string;
}
interface Graph {
  entities: Entity[];
  relations: Relation[];
}
interface Placed extends Entity {
  x: number;
  y: number;
  degree: number;
}

const TYPE_COLOR: Record<string, string> = {
  project: "var(--brand)",
  file: "var(--muted)",
  agent: "var(--amber)",
};
const colorOf = (type: string) => TYPE_COLOR[type] ?? "var(--ok)";
const labelOf = (name: string) => name.replace(/^(project|file|agent):/, "");

/**
 * Lays the graph out once (a few hundred steps of a spring model) and keeps it still: the view
 * never repaints on its own, so a large memory costs nothing while you read it.
 */
function layout(g: Graph): Placed[] {
  const n = g.entities.length;
  const index = new Map(g.entities.map((e, i) => [e.name, i]));
  const edges = g.relations
    .map((r) => [index.get(r.from), index.get(r.to)] as const)
    .filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);
  const degree = new Array<number>(n).fill(0);
  for (const [a, b] of edges) {
    degree[a]!++;
    degree[b]!++;
  }
  // Start on a circle (deterministic, so the picture doesn't jump between refreshes).
  const pos = g.entities.map((_, i) => {
    const t = (i / Math.max(1, n)) * Math.PI * 2;
    const r = 120 + (i % 7) * 18;
    return { x: Math.cos(t) * r, y: Math.sin(t) * r };
  });
  const k = 130;
  const steps = n > 400 ? 120 : 300;
  for (let step = 0; step < steps; step++) {
    const temp = 18 * (1 - step / steps) + 0.5;
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i]!.x - pos[j]!.x;
        const dy = pos[i]!.y - pos[j]!.y;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        const f = (k * k) / d2;
        disp[i]!.x += dx * f * 0.02;
        disp[i]!.y += dy * f * 0.02;
        disp[j]!.x -= dx * f * 0.02;
        disp[j]!.y -= dy * f * 0.02;
      }
    for (const [a, b] of edges) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const f = (d - k) / d;
      disp[a]!.x -= dx * f * 0.5;
      disp[a]!.y -= dy * f * 0.5;
      disp[b]!.x += dx * f * 0.5;
      disp[b]!.y += dy * f * 0.5;
    }
    for (let i = 0; i < n; i++) {
      // A weak pull to the middle keeps separate islands on screen.
      disp[i]!.x -= pos[i]!.x * 0.01;
      disp[i]!.y -= pos[i]!.y * 0.01;
      const d = Math.max(Math.hypot(disp[i]!.x, disp[i]!.y), 0.01);
      pos[i]!.x += (disp[i]!.x / d) * Math.min(d, temp);
      pos[i]!.y += (disp[i]!.y / d) * Math.min(d, temp);
    }
  }
  return g.entities.map((e, i) => ({ ...e, ...pos[i]!, degree: degree[i]! }));
}

/** The project's memory: what the crew remembers about it, its files and its agents. */
export function MemoryGraph({ project, refreshKey }: { project: string; refreshKey: number }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .memory(project)
      .then((g) => live && (setGraph(g), setError("")))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [project, refreshKey]);

  const placed = useMemo(() => (graph ? layout(graph) : []), [graph]);
  const byName = useMemo(() => new Map(placed.map((p) => [p.name, p])), [placed]);
  const q = query.trim().toLowerCase();
  const matches = (p: Placed) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.observations.some((o) => o.toLowerCase().includes(q));

  // Fit everything in view when the graph changes and whenever the panel is resized.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !placed.length) return;
    const xs = placed.map((p) => p.x);
    const ys = placed.map((p) => p.y);
    const fit = () => {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const w = Math.max(...xs) - Math.min(...xs) + 180;
      const h = Math.max(...ys) - Math.min(...ys) + 120;
      const scale = Math.min(1.6, Math.max(0.2, Math.min(box.width / w, box.height / h)));
      setView({
        scale,
        x: box.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * scale,
        y: box.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * scale,
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [placed]);

  if (error) return <p className="ws-empty err-text">{error}</p>;
  if (!graph)
    return (
      <p className="ws-empty">
        <Spinner /> Loading memory…
      </p>
    );
  if (!graph.entities.length)
    return (
      <p className="ws-empty">
        Nothing remembered yet. After each finished thread the crew records the project, the files it
        changed and who changed them here.
      </p>
    );

  const sel = selected ? byName.get(selected) : undefined;
  const links = sel
    ? graph.relations.filter((r) => r.from === sel.name || r.to === sel.name)
    : [];
  const near = new Set(links.flatMap((r) => [r.from, r.to]));

  return (
    <div className="memory">
      <div className="memory-bar">
        <label className="memory-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory"
            aria-label="Search memory"
          />
        </label>
        <span className="muted small">
          {graph.entities.length} nodes · {graph.relations.length} links
        </span>
        <span className="memory-legend">
          {["project", "file", "agent"].map((t) => (
            <span key={t}>
              <i style={{ background: colorOf(t) }} /> {t}
            </span>
          ))}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="memory-canvas"
        role="img"
        aria-label="Memory graph"
        onWheel={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - box.left;
          const my = e.clientY - box.top;
          const f = Math.exp(-e.deltaY * 0.0015);
          setView((v) => {
            const scale = Math.min(4, Math.max(0.15, v.scale * f));
            const r = scale / v.scale;
            return { scale, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r };
          });
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".mem-node")) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={(e) => {
          if (drag.current && Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) < 3)
            setSelected(null);
          drag.current = null;
        }}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {graph.relations.map((r, i) => {
            const a = byName.get(r.from);
            const b = byName.get(r.to);
            if (!a || !b) return null;
            const on = sel && (r.from === sel.name || r.to === sel.name);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`mem-edge ${on ? "is-on" : sel ? "is-dim" : ""}`}
              />
            );
          })}
          {placed.map((p) => {
            const r = 5 + Math.min(10, Math.sqrt(p.degree) * 2.4);
            const dim = (sel && !near.has(p.name) && sel.name !== p.name) || !matches(p);
            return (
              <g
                key={p.name}
                className={`mem-node ${dim ? "is-dim" : ""} ${sel?.name === p.name ? "is-sel" : ""}`}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => setSelected(p.name === selected ? null : p.name)}
                tabIndex={0}
                role="button"
                aria-label={`${p.entityType} ${labelOf(p.name)}`}
                onKeyDown={(e) => e.key === "Enter" && setSelected(p.name)}
              >
                <circle r={r} fill={colorOf(p.entityType)} />
                {(view.scale > 0.6 || p.entityType !== "file" || sel?.name === p.name) && (
                  <text y={r + 12} textAnchor="middle">
                    {labelOf(p.name).length > 28 ? `${labelOf(p.name).slice(0, 27)}…` : labelOf(p.name)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {sel && (
        <aside className="memory-detail">
          <header>
            <i style={{ background: colorOf(sel.entityType) }} />
            <strong className="truncate">{labelOf(sel.name)}</strong>
            <span className="muted small">{sel.entityType}</span>
            <button className="icon-btn small-btn" onClick={() => setSelected(null)} aria-label="Close">
              <Icon name="x" size={13} />
            </button>
          </header>
          {links.length > 0 && (
            <ul className="memory-links">
              {links.slice(0, 30).map((r, i) => (
                <li key={i}>
                  <button className="link" onClick={() => setSelected(r.from === sel.name ? r.to : r.from)}>
                    {r.from === sel.name
                      ? `${r.relationType} → ${labelOf(r.to)}`
                      : `${labelOf(r.from)} → ${r.relationType}`}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ol className="memory-obs">
            {[...sel.observations].reverse().map((o, i) => (
              <li key={i}>{o}</li>
            ))}
            {!sel.observations.length && <li className="muted">No notes.</li>}
          </ol>
        </aside>
      )}
    </div>
  );
}
