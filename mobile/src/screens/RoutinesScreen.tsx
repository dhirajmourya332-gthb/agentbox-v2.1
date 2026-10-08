import { useState } from "react";
import { showDialog } from "../ui/dialog";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Routine, RoutineRun } from "../lib/types";
import { Button, Card, Dot, Screen, T } from "../ui/kit";
import { relTime, usePalette } from "../ui/theme";

function runState(run: RoutineRun | null): { word: string; tone: "ok" | "warn" | "bad" | "muted" | "accent" } {
  if (!run) return { word: "Never run", tone: "muted" };
  if (run.outcome === "skipped") return { word: "Skipped", tone: "warn" };
  switch (run.task_status) {
    case "done": return { word: "Done", tone: "ok" };
    case "running": return { word: "Running", tone: "accent" };
    case "queued": return { word: "Queued", tone: "accent" };
    case "stopped": return { word: "Stopped", tone: "bad" };
    default: return { word: "Failed", tone: "bad" };
  }
}

export function RoutinesScreen() {
  const p = usePalette();
  const { routines, nameOf, refresh, paused } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const runNow = (r: Routine) =>
    showDialog(`Run "${r.name}" now?`, paused ? "Agents are paused, so this run will be skipped." : "It starts a run straight away.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Run now",
        onPress: async () => {
          setBusy(r.id);
          try {
            const res = await api.runRoutine(r.id);
            if (!res.started) showDialog("Not started", res.routine?.last_run?.reason ?? "The run was skipped.");
          } catch (e) {
            showDialog("Couldn't run it", e instanceof Error ? e.message : "");
          } finally {
            setBusy(null);
          }
        },
      },
    ]);

  return (
    <Screen>
      <FlatList
        data={routines}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} />}
        ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 40 }}>No routines. Create them in the portal.</T>}
        renderItem={({ item: r }) => {
          const s = runState(r.last_run);
          const color = s.tone === "muted" ? p.muted : s.tone === "accent" ? p.accent : p[s.tone];
          return (
            <Card style={{ gap: 6 }}>
              <View style={st.row}>
                <View style={{ flex: 1 }}>
                  <T weight="600">{r.name}</T>
                  <T muted size={13}>{nameOf(r.agent_id) ?? "deleted agent"} · {r.describe}{r.enabled ? "" : " · off"}</T>
                </View>
                <Button small label="Run now" onPress={() => runNow(r)} busy={busy === r.id} />
              </View>
              <View style={st.row}>
                <Dot color={color} size={8} />
                <T size={13} style={{ color }}>{s.word}{r.last_run ? ` · ${relTime(r.last_run.at)}` : ""}</T>
                {r.enabled && r.next_runs[0] && <T muted size={13} style={{ marginLeft: "auto" }}>next {relTime(r.next_runs[0])}</T>}
              </View>
              {r.last_run?.outcome === "skipped" && r.last_run.reason && <T muted size={12}>{r.last_run.reason}</T>}
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
