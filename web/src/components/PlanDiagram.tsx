import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui.tsx";
import dagre from "@dagrejs/dagre";

/**
 * The before/after diagram that leads a plan (docs/V2.1-PLAN.md §1). Agents send two small graphs
 * that share node ids; this merges them and colours what's new, removed and changed, so the owner
 * sees the change without reading. Layout is dagre (left to right); the SVG is ours.
 */

export type PlanNode = { id: string; label: string; change?: string };
export type PlanEdge = { from: string; to: string; label?: string };
export type PlanGraph = { nodes: PlanNode[]; edges: PlanEdge[] };

type Status = "same" | "added" | "removed" | "changed";
type View = "change" | "before" | "after";
type DNode = { id: string; label: string; note?: string; status: Status };
type DEdge = { from: string; to: string; label?: string; was?: string; status: Status };

const edgeKey = (e: PlanEdge) => `${e.from}\u0000${e.to}`;

/** Merge before and after into one graph with a status on every node and edge. */
export function mergeGraphs(before: PlanGraph, after: PlanGraph): { nodes: DNode[]; edges: DEdge[] } {
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const now = new Map(after.nodes.map((n) => [n.id, n]));
  const nodes: DNode[] = after.nodes.map((n) => {
    const old = was.get(n.id);
    if (!old) return { id: n.id, label: n.label, note: n.change, status: "added" };
    const changed = !!n.change || old.label !== n.label;
    return { id: n.id, label: n.label, note: n.change ?? (old.label !== n.label ? `was ${old.label}` : undefined), status: changed ? "changed" : "same" };
  });
  for (const n of before.nodes) if (!now.has(n.id)) nodes.push({ id: n.id, label: n.label, status: "removed" });
  const oldEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const newEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  const edges: DEdge[] = after.edges.map((e) => {
    const old = oldEdges.get(edgeKey(e));
    if (!old) return { ...e, status: "added" };
    // Same arrow, different words on it (e.g. "users + sessions" → "users"): what flows changed.
    return (old.label ?? "") !== (e.label ?? "") ? { ...e, was: old.label ?? "(no label)", status: "changed" } : { ...e, status: "same" };
  });
  for (const e of before.edges) if (!newEdges.has(edgeKey(e))) edges.push({ ...e, status: "removed" });
  return { nodes, edges };
}

function graphFor(view: View, before: PlanGraph, after: PlanGraph) {
  const merged = mergeGraphs(before, after);
  if (view === "change") return merged;
  // Before: the old graph, with what goes away marked. After: the new graph, with what's new marked.
  const keep = (s: Status) => (view === "before" ? s !== "added" : s !== "removed");
  const shown = (s: Status): Status => (view === "before" ? (s === "removed" ? s : "same") : s);
  const oldEdge = (e: DEdge) => before.edges.find((b) => b.from === e.from && b.to === e.to);
  const nodes = merged.nodes.filter((n) => keep(n.status)).map((n) => ({
    ...n, status: shown(n.status), note: view === "before" ? undefined : n.note,
    label: view === "before" ? (before.nodes.find((b) => b.id === n.id)?.label ?? n.label) : n.label,
  }));
  const edges = merged.edges.filter((e) => keep(e.status)).map((e) => ({
    ...e, status: shown(e.status), label: view === "before" ? (oldEdge(e)?.label ?? e.label) : e.label, was: view === "before" ? undefined : e.was,
  }));
  return { nodes, edges };
}

// Readable sizes, never scaled down below them: the canvas scrolls instead, and Expand opens it full screen.
const FONT = { label: 15, sub: 13, edge: 13 };
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

type Box = { label: string[]; sub: string[]; width: number; height: number };
function box(n: DNode): Box {
  const label = wrap(n.label, WRAP.label, 2);
  const subText = n.note ?? TAG[n.status];
  const sub = subText ? wrap(subText, WRAP.sub, 3) : [];
  const w = Math.max(...label.map((l) => l.length * CW.label), ...sub.map((l) => l.length * CW.sub), 80) + PAD.x * 2;
  const h = PAD.y * 2 + label.length * LINE.label + (sub.length ? 4 + sub.length * LINE.sub : 0);
  return { label, sub, width: Math.round(w), height: Math.round(h) };
}

function layoutDir(nodes: DNode[], edges: DEdge[], rankdir: "LR" | "TB") {
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
function layout(nodes: DNode[], edges: DEdge[], budget = 900) {
  const lr = layoutDir(nodes, edges, "LR");
  if (lr.width <= budget) return lr;
  const tb = layoutDir(nodes, edges, "TB");
  return tb.width < lr.width ? tb : lr;
}

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

const TAG: Partial<Record<Status, string>> = { added: "new", removed: "removed" };

type Laid = ReturnType<typeof layout>;

function Drawing({ nodes, edges, laid, scale = 1 }: { nodes: DNode[]; edges: DEdge[]; laid: Laid; scale?: number }) {
  return (
    <svg viewBox={`0 0 ${laid.width} ${laid.height}`} width={Math.round(laid.width * scale)} height={Math.round(laid.height * scale)} role="img"
      aria-label={`Diagram: ${nodes.map((n) => `${n.label}${TAG[n.status] ? ` (${TAG[n.status]})` : ""}${n.note ? `: ${n.note}` : ""}`).join(", ")}`}>
      <defs>
        {(["same", "added", "removed", "changed"] as Status[]).map((s) => (
          <marker key={s} id={`pd-arrow-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={`pd-head ${s}`} />
          </marker>
        ))}
      </defs>
      {edges.map((e, i) => {
        const ed = laid.g.edge({ v: e.from, w: e.to, name: String(i) }) as { points?: { x: number; y: number }[]; x?: number; y?: number } | undefined;
        if (!ed?.points) return null;
        const w = e.label ? e.label.length * CW.edge + 14 : 0;
        return (
          <g key={i} className={`pd-edge ${e.status}`}>
            <path d={pathOf(ed.points)} markerEnd={`url(#pd-arrow-${e.status})`} />
            {e.was && <title>{`was: ${e.was}`}</title>}
            {e.label && ed.x != null && ed.y != null && (
              <>
                <rect className="pd-edge-bg" x={ed.x - w / 2} y={ed.y - 10} width={w} height={20} rx={4} />
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
          <g key={n.id} className={`pd-node ${n.status}`} transform={`translate(${d.x - d.width / 2}, ${d.y - d.height / 2})`}>
            <title>{n.label}{n.note ? ` — ${n.note}` : ""}</title>
            <rect width={d.width} height={d.height} rx={8} />
            {d.label.map((l, i) => (
              <text key={`l${i}`} x={d.width / 2} y={top + i * LINE.label} textAnchor="middle" dominantBaseline="central" className="pd-label" fontSize={FONT.label}>{l}</text>
            ))}
            {d.sub.map((l, i) => (
              <text key={`s${i}`} x={d.width / 2} y={subTop + i * LINE.sub} textAnchor="middle" dominantBaseline="central" className="pd-sub" fontSize={FONT.sub}>{l}</text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function ViewSwitch({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <div className="segmented" aria-label="Diagram view">
      {(["change", "before", "after"] as View[]).map((v) => (
        <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
          {v === "change" ? "Change" : v === "before" ? "Before" : "After"}
        </button>
      ))}
    </div>
  );
}

export function PlanDiagram({ before, after, initial = "change" }: { before: PlanGraph; after: PlanGraph; initial?: View }) {
  const [view, setView] = useState<View>(initial);
  const [full, setFull] = useState(false);
  const hasBefore = before.nodes.length > 0;
  const { nodes, edges } = useMemo(() => graphFor(hasBefore ? view : "after", before, after), [view, before, after, hasBefore]);
  const laid = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const counts = useMemo(() => {
    const all = mergeGraphs(before, after);
    const n = (s: Status) => all.nodes.filter((x) => x.status === s).length + (s === "changed" ? all.edges.filter((e) => e.status === "changed").length : 0);
    return { added: n("added"), removed: n("removed"), changed: n("changed") };
  }, [before, after]);
  const legend = (
    <span className="pd-legend">
      {counts.added > 0 && <span className="added">{counts.added} new</span>}
      {counts.changed > 0 && <span className="changed">{counts.changed} changed</span>}
      {counts.removed > 0 && <span className="removed">{counts.removed} removed</span>}
    </span>
  );

  return (
    <figure className="pd">
      <div className="pd-bar">
        {hasBefore ? <ViewSwitch view={view} setView={setView} /> : <span className="pd-new">All new</span>}
        {legend}
        <button className="btn sm ghost" onClick={() => setFull(true)} title="Open the diagram full screen"><Icon name="expand" size={14} />Expand</button>
      </div>
      <div className="pd-canvas" onDoubleClick={() => setFull(true)}>
        <Drawing nodes={nodes} edges={edges} laid={laid} />
      </div>
      {full && (
        <FullDiagram onClose={() => setFull(false)} nodes={nodes} edges={edges}
          bar={<>{hasBefore ? <ViewSwitch view={view} setView={setView} /> : <span className="pd-new">All new</span>}{legend}</>} />
      )}
    </figure>
  );
}

/** Full screen, laid out for the window and fitted to it, with zoom. */
function FullDiagram({ nodes, edges, bar, onClose }: { nodes: DNode[]; edges: DEdge[]; bar: ReactNode; onClose: () => void }) {
  const laid = useMemo(() => layout(nodes, edges, window.innerWidth - 64), [nodes, edges]);
  // Fit the window, but stay readable (not below 75%) and don't blow small graphs up past 175%.
  const fit = () => Math.max(0.75, Math.min(1.75, (window.innerWidth - 64) / laid.width, (window.innerHeight - 120) / laid.height));
  const [zoom, setZoom] = useState(fit);
  useEffect(() => { setZoom(fit()); }, [laid.width, laid.height]);
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
    <div className="pd-full" role="dialog" aria-modal="true" aria-label="Plan diagram">
      <div className="pd-full-bar">
        {bar}
        <span className="pd-zoom">
          <button className="btn sm ghost" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
          <button className="btn sm ghost" title="Fit to window" onClick={() => setZoom(fit())}>{Math.round(zoom * 100)}%</button>
          <button className="btn sm ghost" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>+</button>
        </span>
        <button className="icon-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="pd-full-canvas">
        <Drawing nodes={nodes} edges={edges} laid={laid} scale={zoom} />
      </div>
    </div>,
    document.body,
  );
}
