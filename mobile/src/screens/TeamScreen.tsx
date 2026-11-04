import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import type { Props } from "../nav";
import { useStore } from "../lib/store";
import { Avatar, Badge, Screen, T } from "../ui/kit";
import { statusColor, usePalette } from "../ui/theme";

/** The team (the portal's Team page): each agent with its status. Opens its own conversation. */
export function TeamScreen({ navigation }: Props<"Team">) {
  const p = usePalette();
  const { agents, refresh } = useStore();
  const roles = useMemo(
    () => agents.filter((a) => !a.base_agent_id && !a.retired_at).sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );
  const working = (id: string) => agents.filter((a) => a.base_agent_id === id && a.status === "working").length;

  return (
    <Screen>
      <FlatList
        data={roles}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        refreshing={false}
        onRefresh={refresh}
        ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>No agents yet. Create them in the portal.</T>}
        renderItem={({ item: a }) => {
          const busy = working(a.id) + (a.status === "working" ? 1 : 0);
          const status = busy ? "working" : a.status;
          return (
            <Pressable onPress={() => navigation.navigate("Agent", { id: a.id, title: a.name })} accessibilityRole="button"
              accessibilityLabel={`${a.name}, ${a.title}, ${status}`}
              style={({ pressed }) => [st.row, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}>
              <Avatar name={a.name} color={a.color} size={36} />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="600" numberOfLines={1}>{a.name}</T>
                <T muted size={13} numberOfLines={1}>{a.title || a.summary || "Agent"}</T>
              </View>
              <Badge label={busy > 1 ? `${busy} working` : status === "working" ? "working" : status} color={statusColor(p, status)} />
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
});
