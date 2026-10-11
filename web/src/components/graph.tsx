import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dagre from "@dagrejs/dagre";
import { Icon } from "./ui.tsx";

/**
 * Shared drawing for agentbox diagrams (plan before/after, roadmaps): boxes with a wrapped label and
 * an optional sub-line, arrows with optional labels, laid out by dagre, drawn as our own SVG at a
 * readable size (never shrunk below it: containers scroll), plus a full-screen view with zoom.
 */

export const FONT = { label: 15, sub: 13, edge: 13 };
const CW = { label: 8.4, sub: 7.2, edge: 7.0 }; // IBM Plex Sans, average glyph width at those sizes
const WRAP = { label: 20, sub: 26 };
const LINE = { label: 19, sub: 17 };
const PAD = { x: 16, y: 11 };

/** Break text into lines of at most `max` characters (on spaces where possible), at most `lines` lines. */
export function wrap(text: string, max: number, lines = 3): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= max) cur += " " + word;
    else { out.push(cur); cur = word; }
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  if (out.length > lines) return [...out.slice(0, lines - 1), out.slice(lines - 1).join(" ").slice(0, max - 1) + "…"];
  return out;
}

/** A box to draw: `cls` styles it (e.g. "added", "done"); `badge` is a short mark drawn in its corner. */
export type GNode = { id: string; label: string; sub?: string; cls: string; title?: string; badge?: string };
export type GEdge = { from: string; to: string; label?: string; cls: string; title?: string };

type Box = { label: string[]; sub: string[]; width: number; height: number };
function box(n: GNode): Box {
  const label = wrap(n.label, WRAP.label, 2);
  const sub = n.sub ? wrap(n.sub, WRAP.sub, 3) : [];
  const w = Math.max(...label.map((l) => l.length * CW.label), ...sub.map((l) => l.length * CW.sub), 80) + PAD.x * 2 + (n.badge ? 14 : 0);
  const h = PAD.y * 2 + label.length * LINE.label + (sub.length ? 4 + sub.length * LINE.sub : 0);
  return { label, sub, width: Math.round(w), height: Math.round(h) };
}

function layoutDir(nodes: GNode[], edges: GEdge[], rankdir: "LR" | "TB") {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: rankdir === "LR" ? 26 : 36, ranksep: rankdir === "LR" ? 80 : 56, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, box(n));
  edges.forEach((e, i) => {
    if (g.hasNode(e.from) && g.hasNode(e.to)) {
      g.setEdge(e.from, e.to, { label: e.label, width: e.label ? e.label.length * CW.edge + 14 : 0, height: e.label ? 20 : 0, labelpos: "c" }, String(i));
    }
  });
  dagre.layout(g);
  const graph = g.graph() as { width?: number; height?: number };
  return { g, width: Math.max(graph.width ?? 0, 120), height: Math.max(graph.height ?? 0, 60) };
}

/** Left to right reads best; when that's much wider than the space (a card, or the screen), top to bottom. */
export function layout(nodes: GNode[], edges: GEdge[], budget = 900) {
  const lr = layoutDir(nodes, edges, "LR");
  if (lr.width <= budget) return lr;
  const tb = layoutDir(nodes, edges, "TB");
  return tb.width < lr.width ? tb : lr;
}
export type Laid = ReturnType<typeof layout>;

/** A smooth path through dagre's edge points. */
function pathOf(points: { x: number; y: number }[]) {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    d += ` Q ${p.x} ${p.y} ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

/** The SVG. `kind` prefixes the CSS classes (e.g. "pd" → .pd-node.added, .pd-edge.removed). */
export function Drawing({ kind, nodes, edges, laid, scale = 1, onNode }: {
  kind: string; nodes: GNode[]; edges: GEdge[]; laid: Laid; scale?: number; onNode?: (id: string) => void;
}) {
  const classes = [...new Set(edges.map((e) => e.cls))];
  return (
    <svg viewBox={`0 0 ${laid.width} ${laid.height}`} width={Math.round(laid.width * scale)} height={Math.round(laid.height * scale)} role="img"
      className={`${kind}-svg`} aria-label={`Diagram: ${nodes.map((n) => `${n.label}${n.sub ? ` (${n.sub})` : ""}`).join(", ")}`}>
      <defs>
        {classes.map((c) => (
          <marker key={c} id={`${kind}-arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={`${kind}-head ${c}`} />
          </marker>
        ))}
      </defs>
      {edges.map((e, i) => {
        const ed = laid.g.edge({ v: e.from, w: e.to, name: String(i) }) as { points?: { x: number; y: number }[]; x?: number; y?: number } | undefined;
        if (!ed?.points) return null;
        const w = e.label ? e.label.length * CW.edge + 14 : 0;
        return (
          <g key={i} className={`${kind}-edge ${e.cls}`}>
            <path d={pathOf(ed.points)} markerEnd={`url(#${kind}-arrow-${e.cls})`} />
            {e.title && <title>{e.title}</title>}
            {e.label && ed.x != null && ed.y != null && (
              <>
                <rect className="g-edge-bg" x={ed.x - w / 2} y={ed.y - 10} width={w} height={20} rx={4} />
                <text x={ed.x} y={ed.y} textAnchor="middle" dominantBaseline="central" fontSize={FONT.edge}>{e.label}</text>
              </>
            )}
          </g>
        );
      })}
      {nodes.map((n) => {
        const d = laid.g.node(n.id) as Box & { x: number; y: number };
        const top = PAD.y + LINE.label / 2;
        const subTop = PAD.y + d.label.length * LINE.label + 4 + LINE.sub / 2;
        return (
          <g key={n.id} className={`${kind}-node ${n.cls}${onNode ? " clickable" : ""}`} transform={`translate(${d.x - d.width / 2}, ${d.y - d.height / 2})`}
            onClick={onNode ? () => onNode(n.id) : undefined}>
            <title>{n.title ?? `${n.label}${n.sub ? ` — ${n.sub}` : ""}`}</title>
            <rect width={d.width} height={d.height} rx={8} />
            {n.badge && <text x={d.width - 12} y={14} textAnchor="middle" dominantBaseline="central" className={`${kind}-badge`} fontSize={12}>{n.badge}</text>}
            {d.label.map((l, i) => (
              <text key={`l${i}`} x={d.width / 2} y={top + i * LINE.label} textAnchor="middle" dominantBaseline="central" className={`${kind}-label`} fontSize={FONT.label}>{l}</text>
            ))}
            {d.sub.map((l, i) => (
              <text key={`s${i}`} x={d.width / 2} y={subTop + i * LINE.sub} textAnchor="middle" dominantBaseline="central" className={`${kind}-sub`} fontSize={FONT.sub}>{l}</text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/** Full screen: laid out for the window and fitted to it (readable: not below 75%), with zoom; Esc closes. */
export function FullScreen({ label, bar, onClose, children }: {
  label: string; bar: ReactNode; onClose: () => void;
  /** Renders the content for the window's width budget at a zoom; returns its natural size for fitting. */
  children: (budget: number) => { size: { width: number; height: number }; render: (zoom: number) => ReactNode };
}) {
  const content = children(window.innerWidth - 64);
  const fit = () => Math.max(0.75, Math.min(1.75, (window.innerWidth - 64) / content.size.width, (window.innerHeight - 120) / content.size.height));
  const [zoom, setZoom] = useState(fit);
  useEffect(() => { setZoom(fit()); }, [content.size.width, content.size.height]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(3, z + 0.25));
      if (e.key === "-") setZoom((z) => Math.max(0.5, z - 0.25));
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="pd-full" role="dialog" aria-modal="true" aria-label={label}>
      <div className="pd-full-bar">
        {bar}
        <span className="pd-zoom">
          <button className="btn sm ghost" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
          <button className="btn sm ghost" title="Fit to window" onClick={() => setZoom(fit())}>{Math.round(zoom * 100)}%</button>
          <button className="btn sm ghost" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>+</button>
        </span>
        <button className="icon-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="pd-full-canvas">{content.render(zoom)}</div>
    </div>,
    document.body,
  );
}

/** Lay out once per graph and budget. */
export function useLayout(nodes: GNode[], edges: GEdge[], budget = 900) {
  return useMemo(() => layout(nodes, edges, budget), [nodes, edges, budget]);
}
