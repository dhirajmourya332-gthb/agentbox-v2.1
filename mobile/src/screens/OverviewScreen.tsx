import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Props } from "../nav";
import { useStore } from "../lib/store";
import type { Attention, Progress, Task, Usage, WorkRoom } from "../lib/types";
import { Avatar, Button, Dot, ErrorBox, Screen, T } from "../ui/kit";
import { RunCard, runProgress } from "../ui/Runs";
import { duration, elapsed, relTime, statusColor, useNow, usePalette } from "../ui/theme";

/**
 * Home: what needs you, what's in progress, what just finished, plus usage and pause state.
 * Live over the signed WebSocket (progress, attention and task events); pull to refresh.
 */

type Nav = Props<"Overview">["navigation"];

/** Where a room id leads: a group, or a task room. */
export function openRoom(nav: Nav | Props<"Work">["navigation"], groups: { id: string; name: string }[], id: string, title?: string) {
  const g = groups.find((x) => x.id === id);
  if (g) nav.navigate("Group", { id, title: g.name });
  else nav.navigate("Room", { id, title });
}

export function OverviewScreen({ navigation }: Props<"Overview">) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const now = useNow(15_000);
  const s = useStore();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await s.refresh();
    setRefreshing(false);
  };

  /** Which task room (root id) an instance belongs to. */
  const roomOf = useMemo(() => {
    const m = new Map<string, WorkRoom>();
    for (const r of [...s.work.live, ...s.work.done]) {
      m.set(r.root.id, r);
      r.members.forEach((x) => m.set(x.id, r));
    }
    return m;
  }, [s.work]);
  const labelOf = (agentId: string) => {
    const r = roomOf.get(agentId);
    const inst = r ? [r.root, ...r.members].find((x) => x.id === agentId) : undefined;
    return inst?.label ?? undefined;
  };

  // In progress: contract A when the server has it, otherwise the working instances from /work.
  type Live = { key: string; agentId: string; activity: string; startedAt: string | null; stalled: boolean; stalledFor: number | null; roomId: string | null; summary: string | null };
  const inProgress: Live[] = useMemo(() => {
    if (s.progress) {
      return Object.values(s.progress)
        .sort((a, b) => (a.state === "stalled" ? 0 : 1) - (b.state === "stalled" ? 0 : 1) || a.started_at.localeCompare(b.started_at))
        .map((x: Progress) => ({
          key: x.task_id, agentId: x.agent_id, activity: x.activity || x.step?.summary || "Working", startedAt: x.started_at,
          stalled: x.state === "stalled", stalledFor: x.stalled_for_s, roomId: x.group_id ?? x.root_id ?? roomOf.get(x.agent_id)?.root.id ?? null,
          summary: x.summary,
        }));
    }
    return s.work.live.flatMap((r) => [r.root, ...r.members].filter((m) => m.status === "working").map((m) => ({
      key: m.id, agentId: m.id, activity: m.current ?? "Working", startedAt: null, stalled: false, stalledFor: null, roomId: r.root.id, summary: null,
    })));
  }, [s.progress, s.work.live, roomOf]);

  const unseen = (s.attention ?? []).filter((a) => !a.seen_at);
  const finished = useMemo(
    () => s.recent
      .filter((t) => (t.depth ?? 0) === 0 && (t.status === "done" || t.status === "failed" || t.status === "stopped") && t.source !== "result")
      .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at))
      .slice(0, 12),
    [s.recent],
  );

  const openAttention = (a: Attention) => {
    s.markSeen([a.id]);
    if (a.room_id) openRoom(navigation, s.groups, a.room_id);
    else if (a.agent_id && roomOf.get(a.agent_id)) navigation.navigate("Room", { id: roomOf.get(a.agent_id)!.root.id });
  };
  const openTask = (t: Task) => {
    if (s.groups.some((g) => g.id === t.thread_id)) return openRoom(navigation, s.groups, t.thread_id);
    const r = roomOf.get(t.agent_id);
    if (r) navigation.navigate("Room", { id: r.root.id, title: r.root.label ?? r.root.name });
  };

  return (
    <Screen>
      <View style={[st.bar, { borderColor: p.border }]}>
        <Dot color={s.connected ? p.ok : p.warn} size={8} />
        <T muted size={13} style={{ flex: 1 }} numberOfLines={1}>{s.connected ? "Live" : "Connecting…"}</T>
        <UsageChip usage={s.usage} />
      </View>
      {s.paused && (
        <View style={[st.paused, { backgroundColor: p.surface2, borderColor: p.warn }]}>
          <T size={13} style={{ color: p.warn }} weight="600">All agents are paused.</T>
          <T size={13} muted>Nothing new starts until you resume (top right).</T>
        </View>
      )}
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 110, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {s.error && !s.loaded && <ErrorBox text={s.error} />}

        <Section title="Needs you" count={unseen.length}
          action={unseen.length > 1 ? { label: "Mark all seen", onPress: () => s.markSeen("all") } : undefined}>
          {s.attention === null ? (
            <T muted size={13}>Not available from this agentbox yet.</T>
          ) : unseen.length === 0 ? (
            <T muted size={13}>Nothing needs you right now.</T>
          ) : unseen.slice(0, 20).map((a) => (
            <Row key={a.id} onPress={() => openAttention(a)} label={a.title}>
              <Dot color={a.kind === "failed" ? p.bad : a.kind === "stalled" ? p.warn : p.accent} size={10} />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="600" numberOfLines={2}>{a.title}</T>
                <T muted size={12}>{KIND[a.kind] ?? a.kind} · {relTime(a.created_at)}</T>
              </View>
              <Pressable onPress={() => s.markSeen([a.id])} accessibilityRole="button" accessibilityLabel="Mark seen" hitSlop={10} style={st.seen}>
                <Text style={{ color: p.muted, fontSize: 16 }}>✓</Text>
              </Pressable>
            </Row>
          ))}
        </Section>

        {!!s.runs?.length && (
          <Section title="Routines running" count={s.runs.length}>
            {s.runs.map((r) => (
              <RunCard key={r.id} run={r} progress={runProgress(s.progress, r.id)} now={now}
                onPress={() => navigation.navigate("Run", { id: r.id, title: r.routine_name })} />
            ))}
          </Section>
        )}

        <Section title="In progress" count={inProgress.length}>
          {inProgress.length === 0 ? (
            <T muted size={13}>No agent is working right now.</T>
          ) : inProgress.map((x) => {
            const name = s.nameOf(x.agentId) ?? "agent";
            const label = labelOf(x.agentId);
            return (
              <Row key={x.key} onPress={x.roomId ? () => openRoom(navigation, s.groups, x.roomId!) : undefined} label={`${name}: ${x.activity}`}>
                <Avatar name={name} color={s.colorOf(x.agentId)} size={30} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="600" numberOfLines={1}>{name}{label && label !== name ? <Text style={{ color: p.muted, fontWeight: "400" }}> · {label}</Text> : null}</T>
                  <T size={13} numberOfLines={2}>{x.activity}</T>
                  {x.summary && <T muted size={12} numberOfLines={2}>{x.summary}</T>}
                  <View style={st.meta}>
                    {x.stalled ? (
                      <>
                        <Dot color={p.warn} size={7} />
                        <T size={12} weight="600" style={{ color: p.warn }}>Possibly stuck{x.stalledFor ? ` · no progress for ${duration(x.stalledFor)}` : ""}</T>
                      </>
                    ) : (
                      <>
                        <Dot color={p.accent} size={7} />
                        <T size={12} muted>{x.startedAt ? `Working for ${elapsed(x.startedAt, now)}` : "Working"}</T>
                      </>
                    )}
                  </View>
                </View>
              </Row>
            );
          })}
        </Section>

        <Section title="Recently finished">
          {finished.length === 0 ? (
            <T muted size={13}>Nothing finished recently.</T>
          ) : finished.map((t) => {
            const name = s.nameOf(t.agent_id) ?? "agent";
            const status = t.status === "done" ? "done" : t.status === "failed" ? "failed" : "stopped";
            return (
              <Row key={t.id} onPress={() => openTask(t)} label={`${t.title ?? "Task"}, ${status}`}>
                <Dot color={statusColor(p, status)} size={10} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="600" numberOfLines={1}>{t.title ?? "Untitled task"}</T>
                  <T muted size={12} numberOfLines={2}>
                    {name} · <Text style={{ color: statusColor(p, status) }}>{status === "done" ? "Done" : status === "failed" ? "Failed" : "Stopped"}</Text>
                    {" · "}{relTime(t.finished_at ?? t.created_at)}{t.status === "failed" && t.error ? ` · ${t.error}` : ""}
                  </T>
                </View>
              </Row>
            );
          })}
        </Section>

        <View style={st.links}>
          <Button small label="All tasks" onPress={() => navigation.navigate("Work")} style={{ flex: 1 }} />
          <Button small label="Groups" onPress={() => navigation.navigate("Groups")} style={{ flex: 1 }} />
          <Button small label="Routines" onPress={() => navigation.navigate("Routines")} style={{ flex: 1 }} />
        </View>
        <Button small variant="ghost" label="Settings" onPress={() => navigation.navigate("Settings")} />
      </ScrollView>
      <View style={[st.fab, { bottom: 24 + insets.bottom }]}>
        <Button variant="primary" label="+ New task" onPress={() => navigation.navigate("NewTask")} />
      </View>
    </Screen>
  );
}

const KIND: Record<string, string> = { reply: "Replied", failed: "Failed", stalled: "Possibly stuck", question: "Question" };

function Section({ title, count, action, children }: { title: string; count?: number; action?: { label: string; onPress: () => void }; children: React.ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <T muted weight="600" size={13}>{title.toUpperCase()}</T>
        {!!count && <View style={[st.count, { backgroundColor: p.surface2 }]}><T size={12} weight="600">{count}</T></View>}
        {action && (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8} style={{ marginLeft: "auto" }}>
            <T size={13} weight="600" style={{ color: p.accent }}>{action.label}</T>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

function Row({ children, onPress, label }: { children: React.ReactNode; onPress?: () => void; label: string }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={label}
      style={({ pressed }) => [st.row, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}>
      {children}
    </Pressable>
  );
}

/** Claude usage like the portal's chip: 5-hour window, or "limited" with the reset time. */
function UsageChip({ usage }: { usage: Usage | null }) {
  const p = usePalette();
  if (!usage) return null;
  const five = usage.unifiedWindows?.five_hour?.utilization;
  const week = usage.unifiedWindows?.seven_day?.utilization;
  const rejected = usage.status === "rejected";
  const high = Math.max(five ?? 0, week ?? 0) >= 0.8 || usage.status === "allowed_warning";
  const color = rejected ? p.bad : high ? p.warn : p.ok;
  const pct = (n?: number) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);
  const resets = usage.resetsAt ? new Date(usage.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const text = rejected ? `Claude limited${resets ? ` · resumes ${resets}` : ""}` : `Claude ${pct(five)} · week ${pct(week)}`;
  return (
    <View style={st.usage} accessibilityLabel={`Usage: ${text}`}>
      <Dot color={color} size={7} />
      <T size={12} style={{ color: rejected || high ? color : p.muted }}>{text}</T>
    </View>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  paused: { marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10, borderWidth: 1, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  seen: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  count: { borderRadius: 9, paddingHorizontal: 7, minWidth: 20, alignItems: "center" },
  links: { flexDirection: "row", gap: 8, marginTop: 16 },
  usage: { flexDirection: "row", alignItems: "center", gap: 5 },
  fab: { position: "absolute", right: 16 },
});
