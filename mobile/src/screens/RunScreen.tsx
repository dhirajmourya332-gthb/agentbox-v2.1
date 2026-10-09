import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Props } from "../nav";
import { api, isRoutineRun } from "../lib/api";
import { useStore } from "../lib/store";
import type { InstanceSummary, Message, RoutineRun, RoutineRunView, Step, Task } from "../lib/types";
import { ChatList } from "../ui/ChatList";
import { Button, ErrorBox, Screen, T } from "../ui/kit";
import { entryFromProgress, entryFromTask, FilterChip, LiveBars, MembersSheet, MemberStack, type LiveEntry, type MemberRow } from "../ui/Live";
import { RunBadge, runLength, runTime } from "../ui/Runs";
import { buildRows, isMessageRow, isMineRow, TimelineItem, type TimelineMember, type TimelineRow } from "../ui/Timeline";
import { useNow, usePalette } from "../ui/theme";
import { memberBadge } from "./RoomScreen";

/**
 * One routine run (contract G): its header, the run's own timeline across the routine's instance
 * tree (the room rendering, read-only: no composer), and live status bars while it runs.
 * Kept live from routine-run.updated plus the ordinary message/task/step events of its threads.
 */

const byTime = (a: Message, b: Message) => a.created_at.localeCompare(b.created_at);

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
}

/** Defensive copy of the detail: every list present, the run's members a list. */
function normalize(v: RoutineRunView): RoutineRunView {
  return {
    run: { ...v.run, members: Array.isArray(v.run?.members) ? v.run.members : [] },
    messages: [...(Array.isArray(v.messages) ? v.messages : [])].sort(byTime),
    tasks: Array.isArray(v.tasks) ? v.tasks : [],
    steps: [...(Array.isArray(v.steps) ? v.steps : [])].sort((a, b) => a.seq - b.seq),
    threads: Array.isArray(v.threads) ? v.threads : [],
    members: Array.isArray(v.members) ? v.members : [],
  };
}

const memberKey = (r: RoutineRun) => r.members.map((m) => `${m.id}:${m.status}`).join(",");

export function RunScreen({ route, navigation }: Props<"Run">) {
  const { id } = route.params;
  const p = usePalette();
  const now = useNow(10_000);
  const insets = useSafeAreaInsets();
  const { live, progress, subscribe, connected, work, agents, nameOf, colorOf } = useStore();
  const [view, setView] = useState<RoutineRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const viewRef = useRef<RoutineRunView | null>(null);
  viewRef.current = view;

  const load = useCallback(() => {
    api.routineRun(id)
      .then((v) => { setView(normalize(v)); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the run"));
  }, [id]);
  // Load on open and again after a reconnect (to catch up on anything missed).
  useEffect(() => { if (connected || !viewRef.current) load(); }, [load, connected]);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reloadSoon = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(load, 800);
  }, [load]);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  useEffect(() => subscribe((e) => {
    const v = viewRef.current;
    if (!v) return;
    switch (e.type) {
      case "routine-run.updated": {
        if (!isRoutineRun(e.run) || e.run.id !== id) return;
        const run: RoutineRun = { ...e.run, members: Array.isArray(e.run.members) ? e.run.members : [] };
        // New members or a finish change what the window holds: fetch the detail again.
        if (memberKey(run) !== memberKey(v.run) || run.status !== v.run.status) reloadSoon();
        setView((cur) => (cur ? { ...cur, run } : cur));
        return;
      }
      case "message.created": {
        const m = e.message as Message | undefined;
        if (!m?.id || !v.threads.some((t) => t.id === m.thread_id)) return;
        if (v.run.finished_at && m.created_at > v.run.finished_at) return; // after the run's window
        setView((cur) => (cur ? { ...cur, messages: upsert(cur.messages, m).sort(byTime) } : cur));
        return;
      }
      case "task.updated": {
        const t = e.task as Task | undefined;
        if (!t?.id) return;
        const known = v.tasks.some((x) => x.id === t.id);
        if (!known && (v.run.finished_at || !v.threads.some((th) => th.id === t.thread_id))) return;
        setView((cur) => (cur ? { ...cur, tasks: upsert(cur.tasks, t) } : cur));
        return;
      }
      case "step.updated": {
        const s = e.step as Step | undefined;
        if (!s?.id || !v.tasks.some((x) => x.id === s.task_id)) return;
        setView((cur) => (cur ? { ...cur, steps: upsert(cur.steps, s).sort((a, b) => a.seq - b.seq) } : cur));
        return;
      }
    }
  }), [subscribe, id, reloadSoon]);

  const run = view?.run;
  const running = run?.status === "running";

  // Who's who: the detail's instances, then the run's member list, then anything the store knows.
  const members = useMemo(() => {
    const m = new Map<string, TimelineMember & { id: string; full?: InstanceSummary }>();
    for (const x of view?.members ?? []) m.set(x.id, { id: x.id, name: x.name, label: x.label, color: x.color, full: x });
    for (const x of run?.members ?? []) if (!m.has(x.id)) m.set(x.id, { id: x.id, name: x.name, label: x.label, color: colorOf(x.id) });
    return m;
  }, [view?.members, run?.members, colorOf]);
  const member = useCallback((iid: string | undefined): TimelineMember | undefined => {
    if (!iid) return undefined;
    const hit = members.get(iid);
    if (hit) return hit;
    const name = nameOf(iid);
    return name ? { name, color: colorOf(iid) } : undefined;
  }, [members, nameOf, colorOf]);

  const byThread = useMemo(() => new Map((view?.threads ?? []).map((t) => [t.id, t.agent_id])), [view?.threads]);
  const threadAgent = useCallback((tid: string) => byThread.get(tid), [byThread]);
  const taskById = useMemo(() => new Map((view?.tasks ?? []).map((t) => [t.id, t])), [view?.tasks]);
  const taskOf = useCallback((tid: string) => taskById.get(tid), [taskById]);

  const rows: TimelineRow[] = useMemo(
    () => (view ? buildRows(view.messages, view.tasks, filter, threadAgent) : []),
    [view, filter, threadAgent],
  );

  const memberRows: MemberRow[] = useMemo(() => [...members.values()].map((m) => {
    const full = m.full;
    const status = full ? memberBadge(full) : run?.members.find((x) => x.id === m.id)?.status === "working" ? "working" : "idle";
    const role = full ? agents.find((a) => a.id === full.role_id) : undefined;
    return {
      id: m.id, name: m.name, color: m.color, badge: status, lead: m.id === run?.instance_id, indent: !!full?.parent_instance_id,
      role: [role?.title || role?.name, m.label].filter(Boolean).join(" · ") || "Agent",
      current: Object.values(progress ?? {}).find((x) => x.agent_id === m.id)?.activity ?? full?.current ?? null,
    };
  }), [members, run, agents, progress]);

  const liveEntries: LiveEntry[] = useMemo(() => {
    if (!view || !running) return [];
    if (progress) {
      const all = Object.values(progress);
      const tagged = all.filter((x) => x.run_id === id);
      // Servers that don't tag run_id yet: fall back to the run's own instances.
      const mine = tagged.length || all.some((x) => x.run_id !== undefined) ? tagged : all.filter((x) => members.has(x.agent_id));
      return mine.map((x) => entryFromProgress(x, member(x.agent_id)?.name ?? "agent", member(x.agent_id)?.color));
    }
    return view.tasks.filter((t) => t.status === "running")
      .map((t) => entryFromTask(t, view.steps, member(t.agent_id)?.name ?? "agent", member(t.agent_id)?.color));
  }, [view, running, progress, id, members, member]);

  /** The routine's room, if the work list has one holding the routine's instance. */
  const roomId = useMemo(() => {
    const iid = run?.instance_id;
    if (!iid) return null;
    const r = [...work.live, ...work.done].find((w) => w.root.id === iid || w.members.some((m) => m.id === iid));
    return r?.root.id ?? null;
  }, [run?.instance_id, work]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: run?.routine_name ?? route.params.title ?? "Routine run",
      headerRight: memberRows.length ? () => <MemberStack members={memberRows} onPress={() => setSheet(true)} /> : undefined,
    });
  }, [navigation, run?.routine_name, route.params.title, memberRows]);

  if (error && !view) return <Screen style={{ padding: 16 }}><ErrorBox text={error} /></Screen>;
  if (!view || !run) return <Screen style={{ justifyContent: "center" }}><ActivityIndicator color={p.muted} /></Screen>;

  const filtered = filter ? member(filter) : undefined;
  const length = runLength(run, now);

  return (
    <Screen>
      <View style={[st.head, { borderColor: p.border, backgroundColor: p.surface }]}>
        <View style={st.row}>
          <T weight="700" size={16} numberOfLines={1} style={{ flex: 1 }}>{run.routine_name}</T>
          <RunBadge status={run.status} />
        </View>
        <T muted size={13} numberOfLines={1}>
          {[runTime(run.started_at), length ? (running ? `running for ${length}` : `took ${length}`) : null, run.trigger === "manual" ? "started by hand" : "scheduled"]
            .filter(Boolean).join(" · ")}
        </T>
        {run.status === "skipped" && run.reason && <T muted size={13}>{run.reason}</T>}
        {!running && run.status !== "skipped" && run.summary && <T size={13} numberOfLines={3}>{run.summary}</T>}
      </View>
      {filtered && <FilterChip name={filtered.label ?? filtered.name} onClear={() => setFilter(null)} />}
      <ChatList
        data={rows}
        isMessage={isMessageRow}
        isMine={isMineRow}
        resetKey={filter}
        footer={rows.length ? null : (
          <T muted size={13} style={{ textAlign: "center", marginTop: 24 }}>
            {run.status === "skipped" ? "This run was skipped, so nothing happened." : running ? "Nothing posted yet." : "Nothing was posted in this run."}
          </T>
        )}
        renderItem={({ item }) => (
          <TimelineItem item={item} member={member} threadAgent={threadAgent} task={taskOf} steps={view.steps} live={live} />
        )}
      />
      <LiveBars entries={liveEntries} steps={view.steps} />
      <View style={[st.foot, { borderColor: p.border, paddingBottom: 10 + insets.bottom }]}>
        <T muted size={13} style={{ flex: 1 }}>Routine runs are read-only.</T>
        {roomId && <Button small label="Open routine room" onPress={() => navigation.navigate("Room", { id: roomId })} />}
      </View>
      <MembersSheet visible={sheet} members={memberRows} filter={filter} onFilter={setFilter} onClose={() => setSheet(false)} />
    </Screen>
  );
}

const st = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingVertical: 10, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  foot: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
