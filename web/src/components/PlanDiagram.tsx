import { useMemo, useState } from "react";
import { Icon } from "./ui.tsx";
import { Drawing, FullScreen, layout, useLayout, type GEdge, type GNode } from "./graph.tsx";

/**
 * The before/after diagram that leads a plan (docs/V2.1-PLAN.md §1). Agents send two small graphs
 * that share node ids; this merges them and colours what's new, removed and changed, so the owner
 * sees the change without reading. Drawn by graph.tsx (dagre layout, our own SVG).
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

const TAG: Partial<Record<Status, string>> = { added: "new", removed: "removed" };

const toG = (nodes: DNode[], edges: DEdge[]): { nodes: GNode[]; edges: GEdge[] } => ({
  nodes: nodes.map((n) => ({ id: n.id, label: n.label, sub: n.note ?? TAG[n.status], cls: n.status })),
  edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.label, cls: e.status, title: e.was ? `was: ${e.was}` : undefined })),
});

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
  const { nodes, edges } = useMemo(() => {
    const g = graphFor(hasBefore ? view : "after", before, after);
    return toG(g.nodes, g.edges);
  }, [view, before, after, hasBefore]);
  const laid = useLayout(nodes, edges);
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
        <Drawing kind="pd" nodes={nodes} edges={edges} laid={laid} />
      </div>
      {full && (
        <FullScreen label="Plan diagram" onClose={() => setFull(false)}
          bar={<>{hasBefore ? <ViewSwitch view={view} setView={setView} /> : <span className="pd-new">All new</span>}{legend}</>}>
          {(budget) => {
            const big = layout(nodes, edges, budget);
            return { size: big, render: (zoom) => <Drawing kind="pd" nodes={nodes} edges={edges} laid={big} scale={zoom} /> };
          }}
        </FullScreen>
      )}
    </figure>
  );
}
