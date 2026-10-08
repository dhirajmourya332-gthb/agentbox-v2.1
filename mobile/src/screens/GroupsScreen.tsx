import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import type { Props } from "../nav";
import { useStore } from "../lib/store";
import { Avatar, Dot, Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";

/** Groups: shared conversations with several agents. Read and post here; set them up in the portal. */
export function GroupsScreen({ navigation }: Props<"Groups">) {
  const p = usePalette();
  const { groups, agents, progress, attention, refresh, loaded } = useStore();
  const [refreshing, setRefreshing] = useState(false);

  return (
    <Screen>
      <FlatList
        data={[...groups].sort((a, b) => a.name.localeCompare(b.name))}
        keyExtractor={(g) => g.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} />}
        ListEmptyComponent={loaded ? <T muted style={{ textAlign: "center", marginTop: 40 }}>No groups yet. Create one in the portal.</T> : null}
        renderItem={({ item: g }) => {
          const members = (g.members ?? []).map((id) => agents.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
          const working = Object.values(progress ?? {}).filter((x) => x.group_id === g.id).length;
          const unseen = (attention ?? []).filter((a) => !a.seen_at && a.room_id === g.id).length;
          return (
            <Pressable onPress={() => navigation.navigate("Group", { id: g.id, title: g.name })} accessibilityRole="button"
              accessibilityLabel={`${g.name}${working ? `, ${working} working` : ""}${unseen ? `, ${unseen} need you` : ""}`}
              style={({ pressed }) => [st.row, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}>
              <View style={[st.hash, { backgroundColor: p.surface2 }]}><T weight="700" size={18}>#</T></View>
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <T weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>{g.name}</T>
                  {unseen > 0 && <Dot color={p.accent} size={8} />}
                </View>
                {!!g.purpose && <T muted size={13} numberOfLines={2}>{g.purpose}</T>}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <View style={{ flexDirection: "row" }}>
                    {members.slice(0, 5).map((a, i) => (
                      <View key={a.id} style={{ marginLeft: i ? -6 : 0, borderRadius: 11, borderWidth: 1.5, borderColor: p.surface }}>
                        <Avatar name={a.name} color={a.color} size={18} />
                      </View>
                    ))}
                  </View>
                  <T muted size={12}>
                    {members.length} member{members.length === 1 ? "" : "s"}
                    {working ? ` · ${working} working` : ""}{g.paused ? " · paused" : ""}
                  </T>
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", gap: 12, padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: "center" },
  hash: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
