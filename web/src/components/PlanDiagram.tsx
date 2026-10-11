import { useMemo, useState } from "react";
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

const CHAR_W = 7.4; // IBM Plex Sans at 13px, roughly
const nodeSize = (n: DNode) => ({
  width: Math.min(230, Math.max(104, Math.max(n.label.length, (n.note?.length ?? 0) * 0.86) * CHAR_W + 28)),
  height: n.note || n.status === "added" || n.status === "removed" ? 54 : 40,
});

function layout(nodes: DNode[], edges: DEdge[]) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 64, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { ...nodeSize(n) });
  edges.forEach((e, i) => {
    if (g.hasNode(e.from) && g.hasNode(e.to)) {
      g.setEdge(e.from, e.to, { label: e.label, width: e.label ? e.label.length * 6.4 + 8 : 0, height: e.label ? 16 : 0, labelpos: "c" }, String(i));
    }
  });
  dagre.layout(g);
  const graph = g.graph() as { width?: number; height?: number };
  return { g, width: Math.max(graph.width ?? 0, 120), height: Math.max(graph.height ?? 0, 60) };
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

export function PlanDiagram({ before, after, initial = "change" }: { before: PlanGraph; after: PlanGraph; initial?: View }) {
  const [view, setView] = useState<View>(initial);
  const hasBefore = before.nodes.length > 0;
  const { nodes, edges } = useMemo(() => graphFor(hasBefore ? view : "after", before, after), [view, before, after, hasBefore]);
  const laid = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const counts = useMemo(() => {
    const m = mergeGraphs(before, after).nodes;
    const all = mergeGraphs(before, after);
    const n = (s: Status) => m.filter((x) => x.status === s).length + (s === "changed" ? all.edges.filter((e) => e.status === "changed").length : 0);
    return { added: n("added"), removed: n("removed"), changed: n("changed") };
  }, [before, after]);

  return (
    <figure className="pd">
      <div className="pd-bar">
        {hasBefore ? (
          <div className="segmented" aria-label="Diagram view">
            {(["change", "before", "after"] as View[]).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "change" ? "Change" : v === "before" ? "Before" : "After"}
              </button>
            ))}
          </div>
        ) : <span className="pd-new">All new</span>}
        <span className="pd-legend">
          {counts.added > 0 && <span className="added">{counts.added} new</span>}
          {counts.changed > 0 && <span className="changed">{counts.changed} changed</span>}
          {counts.removed > 0 && <span className="removed">{counts.removed} removed</span>}
        </span>
      </div>
      <div className="pd-canvas">
        <svg viewBox={`0 0 ${laid.width} ${laid.height}`} width={laid.width} height={laid.height} role="img"
          aria-label={`Diagram: ${nodes.map((n) => `${n.label}${TAG[n.status] ? ` (${TAG[n.status]})` : ""}`).join(", ")}`}>
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
            return (
              <g key={i} className={`pd-edge ${e.status}`}>
                <path d={pathOf(ed.points)} markerEnd={`url(#pd-arrow-${e.status})`} />
                {e.was && <title>{`was: ${e.was}`}</title>}
                {e.label && ed.x != null && ed.y != null && (
                  <>
                    <rect className="pd-edge-bg" x={ed.x - (e.label.length * 6.4 + 10) / 2} y={ed.y - 9} width={e.label.length * 6.4 + 10} height={18} rx={4} />
                    <text x={ed.x} y={ed.y} textAnchor="middle" dominantBaseline="central">{e.label}</text>
                  </>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const d = laid.g.node(n.id) as { x: number; y: number; width: number; height: number };
            const sub = n.note ?? TAG[n.status];
            return (
              <g key={n.id} className={`pd-node ${n.status}`} transform={`translate(${d.x - d.width / 2}, ${d.y - d.height / 2})`}>
                <title>{n.label}{n.note ? ` — ${n.note}` : ""}</title>
                <rect width={d.width} height={d.height} rx={7} />
                <text x={d.width / 2} y={sub ? 21 : d.height / 2} textAnchor="middle" dominantBaseline="central" className="pd-label">{n.label}</text>
                {sub && <text x={d.width / 2} y={39} textAnchor="middle" dominantBaseline="central" className="pd-sub">{sub}</text>}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
