import { useEffect } from "react";
import { ActivityIndicator, FlatList, Linking, StyleSheet, View } from "react-native";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { showDialog } from "../ui/dialog";
import { Badge, Button, Card, ErrorBox, Screen, T } from "../ui/kit";
import { relTime, usePalette } from "../ui/theme";
import { NOT_AVAILABLE, useFetch } from "../ui/useFetch";

/**
 * What agents are serving (the portal's hosted services): open one in the phone's browser (its
 * address is on the tailnet), or stop it.
 */
export function HostedScreen({ navigation }: Props<"Hosted">) {
  const p = usePalette();
  const { subscribe } = useStore();
  const list = useFetch(() => api.hosted());
  useEffect(() => subscribe((e) => { if (e.type === "hosting.updated") list.refresh(); }), [subscribe, list.refresh]);

  const stop = (id: string, name: string) =>
    showDialog(`Stop ${name}?`, "The agent that started it can start it again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => { api.stopHosted(id).then(() => list.refresh(), (e: unknown) => showDialog("Couldn't stop it", e instanceof Error ? e.message : "")); } },
    ]);

  const open = (url: string) => {
    if (!/^https?:\/\//.test(url)) return;
    Linking.openURL(url).catch(() => showDialog("Couldn't open it", "Open it on a device in your tailnet."));
  };

  if (list.missing) return <Screen style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></Screen>;
  if (!list.data) return <Screen style={{ padding: 16 }}>{list.error ? <ErrorBox text={list.error} /> : <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />}</Screen>;
  return (
    <Screen>
      <FlatList
        data={list.data.services}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshing={list.refreshing}
        onRefresh={list.pull}
        ListHeaderComponent={<T muted size={13}>Apps and sites agents are serving. They open in your browser over Tailscale.</T>}
        ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>Nothing is being served right now.</T>}
        renderItem={({ item: s }) => {
          const up = s.status === "running";
          return (
            <Card style={{ gap: 6 }}>
              <View style={st.row}>
                <T weight="600" style={{ flex: 1 }} numberOfLines={1}>{s.name}</T>
                <Badge label={up ? "running" : s.status} color={up ? p.ok : p.muted} />
              </View>
              <T muted size={12} numberOfLines={1} selectable>{s.url}</T>
              <T muted size={12} numberOfLines={2}>
                by {s.started_by} · {relTime(s.created_at)}{s.stop_reason ? ` · ${s.stop_reason}` : ""}
              </T>
              <View style={st.row}>
                {up && <Button small variant="primary" label="Open" onPress={() => open(s.url)} style={{ flex: 1 }} />}
                <Button small label="Task" onPress={() => navigation.navigate("Room", { id: s.room_id })} style={{ flex: 1 }} />
                {up && <Button small variant="danger" label="Stop" onPress={() => stop(s.id, s.name)} style={{ flex: 1 }} />}
              </View>
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({ row: { flexDirection: "row", alignItems: "center", gap: 8 } });
