import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { ActivityItem } from "../lib/types";
import { Avatar, Dot, ErrorBox, Screen, T } from "../ui/kit";
import { relTime, usePalette } from "../ui/theme";
import { NOT_AVAILABLE, useFetch } from "../ui/useFetch";

/** The team's activity feed (the portal's Activity page): who did what, newest first. */
export function ActivityScreen({ navigation }: Props<"Activity">) {
  const p = usePalette();
  const { nameOf, colorOf, groups } = useStore();
  const feed = useFetch(() => api.activity(200));

  /** Where an item's portal link points, on the phone. Unknown links aren't tappable. */
  const target = (it: ActivityItem): (() => void) | undefined => {
    const link = it.link ?? "";
    let m = /^#\/work\/([A-Za-z0-9_-]+)$/.exec(link);
    if (m) { const id = m[1]; return () => navigation.navigate("Room", { id }); }
    m = /^#\/groups\/([A-Za-z0-9_-]+)$/.exec(link);
    if (m) { const id = m[1]; return () => navigation.navigate("Group", { id, title: groups.find((g) => g.id === id)?.name }); }
    m = /^#\/agents\/([A-Za-z0-9_-]+)/.exec(link);
    if (m) { const id = m[1]; return () => navigation.navigate("Agent", { id }); }
    if (/^#\/routines/.test(link)) return () => navigation.navigate("Routines");
    m = /^\/api\/file\?path=(.+)$/.exec(link);
    if (m) {
      let path = "";
      try { path = decodeURIComponent(m[1]); } catch { return undefined; }
      return () => navigation.navigate("Doc", { path, name: path.split("/").pop() ?? "Document" });
    }
    return undefined;
  };

  if (feed.missing) return <Screen style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></Screen>;
  if (!feed.data) {
    return (
      <Screen style={{ padding: 16 }}>
        {feed.error ? <ErrorBox text={feed.error} /> : <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />}
      </Screen>
    );
  }
  return (
    <Screen>
      <FlatList
        data={feed.data}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ padding: 16, gap: 6 }}
        refreshing={feed.refreshing}
        onRefresh={feed.pull}
        ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>Nothing has happened yet.</T>}
        renderItem={({ item: it }) => {
          const who = it.actor === "user" ? "You" : it.actor === "routine" ? "Routine" : nameOf(it.agent_id ?? it.actor) ?? it.actor;
          const open = target(it);
          const tone = it.kind === "failed" ? p.bad : it.kind === "finished" ? p.ok : it.kind === "phone" ? p.accent : it.kind === "stopped" || it.kind === "skipped" ? p.warn : p.muted;
          return (
            <Pressable onPress={open} disabled={!open} accessibilityRole={open ? "button" : undefined} accessibilityLabel={`${who} ${it.title}`}
              style={({ pressed }) => [st.row, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}>
              {it.agent_id ? <Avatar name={who} color={colorOf(it.agent_id)} size={26} /> : <View style={st.dot}><Dot color={tone} size={10} /></View>}
              <View style={{ flex: 1, gap: 2 }}>
                <T size={14} numberOfLines={3}><T size={14} weight="600">{who}</T> {it.title}</T>
                <T muted size={12} numberOfLines={2}>{[it.detail, relTime(it.ts)].filter(Boolean).join(" · ")}</T>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
});
