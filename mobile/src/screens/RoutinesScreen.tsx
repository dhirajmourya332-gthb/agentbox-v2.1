import { useCallback, useEffect, useRef, useState } from "react";
import { showDialog } from "../ui/dialog";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import type { Props } from "../nav";
import { api, isRoutineRun } from "../lib/api";
import { isMissingRoute, useStore } from "../lib/store";
import type { Routine, RoutineLastRun, RoutineRun } from "../lib/types";
import { Button, Card, Dot, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import { RunCard, RunHistoryRow, runProgress } from "../ui/Runs";
import { relTime, useNow, usePalette } from "../ui/theme";

/**
 * Routines: what's running now (Active), what ran (History, paged with `before`) and the
 * schedules with Run now. Against a server without the routine-run routes (contract G), only the
 * schedules show, without the tabs.
 */

type Tab = "active" | "history" | "schedules";
const PAGE = 30;

function runState(run: RoutineLastRun | null): { word: string; tone: "ok" | "warn" | "bad" | "muted" | "accent" } {
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

export function RoutinesScreen({ navigation }: Props<"Routines">) {
  const { runs, runsSupported } = useStore();
  const [tab, setTab] = useState<Tab>(() => (runs?.length ? "active" : "schedules"));
  const [historyMissing, setHistoryMissing] = useState(false);
  const supported = runsSupported === true && !historyMissing;
  const open = (r: RoutineRun) => navigation.navigate("Run", { id: r.id, title: r.routine_name });

  return (
    <Screen>
      {supported && (
        <View style={st.tabs}>
          <Segmented value={tab} onChange={setTab} options={[
            { key: "active", label: runs?.length ? `Active (${runs.length})` : "Active" },
            { key: "history", label: "History" },
            { key: "schedules", label: "Schedules" },
          ]} />
        </View>
      )}
      {!supported || tab === "schedules" ? <Schedules />
        : tab === "active" ? <Active onOpen={open} />
        : <History onOpen={open} onMissing={() => setHistoryMissing(true)} />}
    </Screen>
  );
}

function Active({ onOpen }: { onOpen: (r: RoutineRun) => void }) {
  const { runs, progress, refresh } = useStore();
  const now = useNow(10_000);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <FlatList
      data={runs ?? []}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} />}
      ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 40 }}>No routine is running right now.</T>}
      renderItem={({ item: r }) => <RunCard run={r} progress={runProgress(progress, r.id)} now={now} onPress={() => onOpen(r)} />}
    />
  );
}

function History({ onOpen, onMissing }: { onOpen: (r: RoutineRun) => void; onMissing: () => void }) {
  const p = usePalette();
  const { subscribe } = useStore();
  const [items, setItems] = useState<RoutineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [end, setEnd] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  /** One page; `before` is the oldest run we have (newest first, so the last item). */
  const fetchPage = useCallback(async (before?: string) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const page = await api.routineRuns({ state: "archive", before, limit: PAGE });
      setItems((cur) => {
        const base = before ? cur ?? [] : [];
        const seen = new Set(base.map((r) => r.id));
        return [...base, ...page.filter((r) => !seen.has(r.id))];
      });
      setEnd(page.length < PAGE);
      setError(null);
    } catch (e) {
      if (isMissingRoute(e)) onMissing();
      else setError(e instanceof Error ? e.message : "Couldn't load the history");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [onMissing]);

  useEffect(() => { fetchPage(); }, [fetchPage]);

  // A run that finishes while the history is open goes to the top.
  useEffect(() => subscribe((e) => {
    if (e.type !== "routine-run.updated" || !isRoutineRun(e.run) || e.run.status === "running") return;
    const run: RoutineRun = { ...e.run, members: Array.isArray(e.run.members) ? e.run.members : [] };
    setItems((cur) => {
      if (!cur) return cur;
      const rest = cur.filter((r) => r.id !== run.id);
      return [run, ...rest].sort((a, b) => b.started_at.localeCompare(a.started_at));
    });
  }), [subscribe]);

  const more = () => {
    if (end || loading || !items?.length) return;
    fetchPage(items[items.length - 1].started_at);
  };

  if (error && !items) return <View style={{ padding: 16 }}><ErrorBox text={error} /></View>;
  if (!items) return <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />;
  return (
    <FlatList
      data={items}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: 16, gap: 8 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await fetchPage(); setRefreshing(false); }} />}
      onEndReached={more}
      onEndReachedThreshold={0.4}
      ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 40 }}>No finished runs yet.</T>}
      ListFooterComponent={
        loading && items.length ? <ActivityIndicator style={{ marginVertical: 12 }} color={p.muted} />
        : error && items.length ? <Button small variant="ghost" label="Couldn't load more. Try again" onPress={more} />
        : null
      }
      renderItem={({ item: r }) => <RunHistoryRow run={r} onPress={r.status === "skipped" ? undefined : () => onOpen(r)} />}
    />
  );
}

function Schedules() {
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
  );
}

const st = StyleSheet.create({
  tabs: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
