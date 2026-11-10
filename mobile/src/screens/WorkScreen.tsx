import { useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Props } from "../nav";
import { isHelperWork, useStore } from "../lib/store";
import type { InstanceSummary, WorkRoom } from "../lib/types";
import { Button, Dot, ErrorBox, Screen, T } from "../ui/kit";
import { relTime, statusColor, usePalette } from "../ui/theme";
import { TagChip, TagFilterBar, UNTAGGED, matchesFilter, useWorkFilter } from "../ui/Tags";

/** A room's overall state: working if anything in it is, else queued/error/idle; done once retired. */
export function roomStatus(r: WorkRoom): { key: string; label: string } {
  if (r.root.retired_at) return { key: "done", label: "Done" };
  const all: InstanceSummary[] = [r.root, ...r.members];
  if (all.some((m) => m.status === "working")) return { key: "working", label: "Working" };
  if (all.some((m) => m.queued > 0)) return { key: "queued", label: "Queued" };
  if (all.some((m) => m.status === "error")) return { key: "error", label: "Error" };
  if (all.some((m) => m.status === "limited")) return { key: "limited", label: "Rate-limited" };
  return { key: "idle", label: "Waiting for you" };
}

export function WorkScreen({ navigation }: Props<"Work">) {
  const p = usePalette();
  const { work, agents, workLoaded, refresh, connected, paused, error, attention } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const insets = useSafeAreaInsets();

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  // The helper's own work stays out of the team's list (as on the portal).
  const live = work.live.filter((r) => !isHelperWork(r, agents));
  const done = work.done.filter((r) => !isHelperWork(r, agents));
  // Tag filter: tags in use here, most used first; a tag nobody has any more shows everything.
  const [tagFilter, setTagFilter] = useWorkFilter();
  const counts = new Map<string, number>();
  for (const r of [...live, ...done]) for (const t of r.root.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const anyUntagged = [...live, ...done].some((r) => !(r.root.tags ?? []).length);
  const filter = tagFilter === UNTAGGED ? (tags.length && anyUntagged ? UNTAGGED : "") : tags.includes(tagFilter) ? tagFilter : "";
  const hidden = live.filter((r) => !matchesFilter(r.root.tags, filter));
  // Hidden work that needs you is still counted, so a filter never hides a question.
  const hiddenIds = new Set(hidden.map((r) => r.root.id));
  const hiddenNeedsYou = new Set((attention ?? []).filter((a) => !a.seen_at && a.kind !== "reply" && a.room_id && hiddenIds.has(a.room_id)).map((a) => a.room_id)).size;
  const sections = [
    { title: "Live", data: live.filter((r) => matchesFilter(r.root.tags, filter)) },
    { title: "Recently done", data: done.filter((r) => matchesFilter(r.root.tags, filter)) },
  ].filter((s) => s.data.length > 0);

  return (
    <Screen>
      <View style={[st.bar, { borderColor: p.border }]}>
        <Dot color={connected ? p.ok : p.warn} size={8} />
        <T muted size={13} style={{ flex: 1 }}>{connected ? "Live" : "Connecting…"}{paused ? " · All agents paused" : ""}</T>
      </View>
      {error && !workLoaded && <View style={{ padding: 16 }}><ErrorBox text={error} /></View>}
      {tags.length > 0 && (
        <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.border }}>
          <TagFilterBar tags={tags} value={filter} onChange={setTagFilter} untagged={anyUntagged} />
        </View>
      )}
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.root.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 100, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderSectionHeader={({ section }) => <T muted weight="600" size={13} style={{ marginTop: 8 }}>{section.title.toUpperCase()}</T>}
        ListFooterComponent={hidden.length > 0 ? (
          <Pressable onPress={() => setTagFilter("")} accessibilityRole="button" style={{ paddingVertical: 12, alignItems: "center" }}>
            <T muted size={13}>
              {hidden.length} more live not #{filter === UNTAGGED ? "untagged" : filter}{hiddenNeedsYou ? ` · ${hiddenNeedsYou} need you` : ""} · Show all
            </T>
          </Pressable>
        ) : null}
        ListEmptyComponent={workLoaded && filter ? null : workLoaded ? <T muted style={{ textAlign: "center", marginTop: 40 }}>No tasks yet. Start one below.</T> : null}
        renderItem={({ item }) => {
          const s = roomStatus(item);
          const title = item.root.label ?? item.root.name;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${title}, ${s.label}`}
              onPress={() => navigation.navigate("Room", { id: item.root.id, title })}
              style={({ pressed }) => [st.row, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}
            >
              <View style={[st.swatch, { backgroundColor: item.root.color || p.muted }]} />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="600" numberOfLines={2}>{title}</T>
                <T muted size={13} numberOfLines={1}>
                  {item.root.name}{item.members.length ? ` · ${item.members.length + 1} tasks` : ""}{item.root.current ? ` · ${item.root.current}` : ""}
                </T>
                {(item.root.tags ?? []).length > 0 && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                    {item.root.tags!.map((t) => <TagChip key={t} tag={t} small on={t === filter} />)}
                  </View>
                )}
                <View style={st.status}>
                  <Dot color={statusColor(p, s.key)} size={8} />
                  <T size={13} style={{ color: statusColor(p, s.key) }}>{s.label}</T>
                  {item.last_activity && <T muted size={13}>· {relTime(item.last_activity)}</T>}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
      <View style={[st.fab, { bottom: 24 + insets.bottom }]}>
        <Button variant="primary" label="+ New task" onPress={() => navigation.navigate("NewTask")} />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", gap: 12, padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  swatch: { width: 4, borderRadius: 2 },
  status: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  fab: { position: "absolute", right: 16 },
});
