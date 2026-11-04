import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Roadmap, RoadmapItem, RoadmapStatus } from "../lib/types";
import { Badge, Card, Dot, ErrorBox, T } from "./kit";
import { PulseDot } from "./Pulse";
import { relTime, usePalette, type Palette } from "./theme";
import { NOT_AVAILABLE, useFetch } from "./useFetch";

/**
 * A task's roadmaps (the portal's Roadmap panel): the plan an agent keeps for long work, by phase,
 * each item with its status. Read-only, live as agents update it.
 */

const LABEL: Record<RoadmapStatus, string> = { todo: "To do", doing: "Doing", done: "Done", blocked: "Blocked", skipped: "Skipped" };
const color = (p: Palette, s: RoadmapStatus) =>
  s === "done" ? p.ok : s === "doing" ? p.accent : s === "blocked" ? p.bad : p.muted;

export function RoadmapPanel({ instanceId }: { instanceId: string }) {
  const p = usePalette();
  const { subscribe } = useStore();
  const f = useFetch(() => api.taskRoadmaps(instanceId));
  const rootId = f.data?.root_id;
  useEffect(() => subscribe((e) => {
    if (e.type === "roadmap.updated" && (!rootId || e.roadmap?.root_id === rootId)) f.refresh();
  }), [subscribe, rootId, f.refresh]);

  if (f.missing) return <View style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></View>;
  if (!f.data) return <View style={{ padding: 16 }}>{f.error ? <ErrorBox text={f.error} /> : <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />}</View>;
  const list = [...f.data.roadmaps].sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || b.updated_at.localeCompare(a.updated_at));
  return (
    <FlatList
      data={list}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
      refreshing={f.refreshing}
      onRefresh={f.pull}
      ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>No roadmap for this task. Agents keep one for long, multi-step work.</T>}
      renderItem={({ item }) => <RoadmapCard r={item} defaultOpen={item.status === "active" || list.length === 1} />}
    />
  );
}

function RoadmapCard({ r, defaultOpen }: { r: Roadmap; defaultOpen: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(defaultOpen);
  const total = r.counts.total || r.items.length;
  const done = (r.counts.done ?? 0) + (r.counts.skipped ?? 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const phases: { name: string; items: RoadmapItem[] }[] = [];
  for (const it of r.items) {
    const name = it.phase || "Items";
    let ph = phases.find((x) => x.name === name);
    if (!ph) phases.push((ph = { name, items: [] }));
    ph.items.push(it);
  }
  return (
    <Card style={{ gap: 10 }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ gap: 6 }}>
        <View style={st.row}>
          <T weight="700" style={{ flex: 1 }} numberOfLines={2}>{r.title}</T>
          {r.status !== "active" && <Badge label={r.status} color={r.status === "done" ? p.ok : p.muted} />}
          <T muted>{open ? "▾" : "▸"}</T>
        </View>
        <View style={[st.track, { backgroundColor: p.surface2 }]}>
          <View style={{ width: `${pct}%`, height: "100%", backgroundColor: p.ok, borderRadius: 4 }} />
        </View>
        <View style={[st.row, { flexWrap: "wrap" }]}>
          <T muted size={12}>{done}/{total} done</T>
          {!!r.counts.doing && <T size={12} style={{ color: p.accent }}>· {r.counts.doing} doing</T>}
          {!!r.counts.blocked && <T size={12} style={{ color: p.bad }}>· {r.counts.blocked} blocked</T>}
          <T muted size={12}>· {r.created_by_name ?? "agent"} · {relTime(r.updated_at)}</T>
        </View>
      </Pressable>
      {open && phases.map((ph) => (
        <View key={ph.name} style={{ gap: 4 }}>
          <T muted weight="600" size={12}>{ph.name.toUpperCase()}</T>
          {ph.items.map((it) => (
            <View key={it.id} style={[st.item, { borderColor: p.border }]}>
              <View style={{ paddingTop: 3 }}>
                {it.status === "doing" ? <PulseDot color={color(p, it.status)} size={8} pulse /> : <Dot color={color(p, it.status)} size={8} />}
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <T size={14} style={it.status === "done" || it.status === "skipped" ? { color: p.muted, textDecorationLine: it.status === "skipped" ? "line-through" : "none" } : undefined}>
                  {it.title}
                </T>
                <T muted size={12} numberOfLines={3}>
                  {[LABEL[it.status], it.owner, it.note].filter(Boolean).join(" · ")}
                </T>
              </View>
            </View>
          ))}
        </View>
      ))}
    </Card>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  track: { height: 6, borderRadius: 4, overflow: "hidden" },
  item: { flexDirection: "row", gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
});
