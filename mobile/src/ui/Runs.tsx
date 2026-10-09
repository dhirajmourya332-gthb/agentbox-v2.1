import { Pressable, StyleSheet, View } from "react-native";
import type { Progress, RoutineRun, RoutineRunStatus } from "../lib/types";
import { Badge, Dot, T } from "./kit";
import { duration, elapsed, relTime, usePalette, type Palette } from "./theme";

/** Shared pieces for routine runs (contract G): status badge, the live card and the history row. */

export const RUN_LABEL: Record<RoutineRunStatus, string> = {
  running: "Running", done: "Done", failed: "Failed", stopped: "Stopped", skipped: "Skipped",
};

export function runColor(p: Palette, status: string): string {
  switch (status) {
    case "running": return p.accent;
    case "done": return p.ok;
    case "failed": return p.bad;
    case "stopped": return p.warn;
    default: return p.muted;
  }
}

export function RunBadge({ status }: { status: RoutineRunStatus }) {
  const p = usePalette();
  return <Badge label={RUN_LABEL[status] ?? status} color={runColor(p, status)} />;
}

/** "Thu, Oct 9, 14:05" in the phone's locale. */
export function runTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How long a finished run took, or how long a running one has been going. */
export function runLength(run: RoutineRun, now = Date.now()): string {
  if (run.status === "running") return elapsed(run.started_at, now);
  if (typeof run.duration_s === "number") return duration(run.duration_s);
  if (run.finished_at) {
    const s = (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000;
    return Number.isFinite(s) ? duration(Math.max(0, s)) : "";
  }
  return "";
}

/** Progress items for this run (contract A's run_id), stalled first. */
export function runProgress(progress: Record<string, Progress> | null, runId: string): Progress[] {
  return Object.values(progress ?? {})
    .filter((x) => x.run_id === runId)
    .sort((a, b) => (a.state === "stalled" ? 0 : 1) - (b.state === "stalled" ? 0 : 1) || a.started_at.localeCompare(b.started_at));
}

/** Who's working on a run: the working members, or everyone in it. */
export function runWorkers(run: RoutineRun): string {
  const working = run.members.filter((m) => m.status === "working");
  const list = (working.length ? working : run.members).map((m) => m.label ?? m.name);
  if (!list.length) return "";
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3}` : list.join(", ");
}

/** A running run: name, who's on it, the live activity line and elapsed time. */
export function RunCard({ run, progress, now, onPress }: { run: RoutineRun; progress: Progress[]; now: number; onPress: () => void }) {
  const p = usePalette();
  const top = progress[0];
  const stalled = top?.state === "stalled";
  const workers = runWorkers(run);
  const activity = top ? top.activity || top.step?.summary || "Working" : "Working";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Routine ${run.routine_name}, running: ${activity}. Open the run`}
      style={({ pressed }) => [st.card, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}>
      <View style={st.row}>
        <T weight="600" numberOfLines={1} style={{ flex: 1 }}>{run.routine_name}</T>
        <RunBadge status={run.status} />
      </View>
      {!!workers && <T muted size={12} numberOfLines={1}>{workers}</T>}
      <T size={13} numberOfLines={2}>{activity}</T>
      <View style={st.row}>
        <Dot color={stalled ? p.warn : p.accent} size={7} />
        {stalled
          ? <T size={12} weight="600" style={{ color: p.warn }}>Possibly stuck{top?.stalled_for_s ? ` · no progress for ${duration(top.stalled_for_s)}` : ""}</T>
          : <T size={12} muted>Running for {elapsed(run.started_at, now)}{run.trigger === "manual" ? " · started by hand" : ""}</T>}
        {progress.length > 1 && <T size={12} muted style={{ marginLeft: "auto" }}>{progress.length} working</T>}
      </View>
    </Pressable>
  );
}

/** A finished run in the history: outcome, duration, when, the one-line summary. Skipped runs are muted. */
export function RunHistoryRow({ run, onPress }: { run: RoutineRun; onPress?: () => void }) {
  const p = usePalette();
  const skipped = run.status === "skipped";
  const len = skipped ? "" : runLength(run);
  const when = relTime(run.finished_at ?? run.started_at);
  const line = skipped ? run.reason ?? "Skipped" : run.summary;
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${run.routine_name}, ${RUN_LABEL[run.status] ?? run.status}, ${when}${line ? `. ${line}` : ""}`}
      style={({ pressed }) => [st.card, { backgroundColor: p.surface, borderColor: p.border, opacity: skipped ? 0.6 : pressed ? 0.8 : 1 }]}>
      <View style={st.row}>
        <T weight="600" numberOfLines={1} style={{ flex: 1, color: skipped ? p.muted : p.text }}>{run.routine_name}</T>
        <RunBadge status={run.status} />
      </View>
      <T muted size={12} numberOfLines={1}>
        {[when, len, run.trigger === "manual" ? "by hand" : null].filter(Boolean).join(" · ")}
      </T>
      {!!line && <T size={13} muted={skipped} numberOfLines={1}>{line}</T>}
    </Pressable>
  );
}

const st = StyleSheet.create({
  card: { padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
