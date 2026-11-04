import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Props } from "../nav";
import { usePairing, useSession } from "../lib/session";
import { isHelperWork, useStore } from "../lib/store";
import { serverName } from "../lib/vault";
import type { Attention, Group, Progress, Usage, WorkRoom } from "../lib/types";
import { Badge } from "../ui/Drawer";
import { Button, Dot, ErrorBox, Screen, T } from "../ui/kit";
import { PulseDot } from "../ui/Pulse";
import { RunCard, runProgress } from "../ui/Runs";
import { elapsed, relTime, useNow, usePalette } from "../ui/theme";
import { roomStatus } from "./WorkScreen";

/**
 * Home: a glance, not the detail. What needs you (collapsed until you open it), and every piece of
 * work and group with a live dot: pulsing while an agent works on it, amber if it looks stuck, and a
 * red marker where something waits for you. Tap through for the room. Everything else is in the
 * menu (burger, top left). Live over the signed WebSocket; pull to refresh.
 */

type Nav = Props<"Overview">["navigation"];

/** Where a room id leads: a group, or a task room. */
export function openRoom(nav: Nav | Props<"Work">["navigation"], groups: { id: string; name: string }[], id: string, title?: string) {
  const g = groups.find((x) => x.id === id);
  if (g) nav.navigate("Group", { id, title: g.name });
  else nav.navigate("Room", { id, title });
}

/** "Needs you": questions, failures, stalls. Replies are "new", not "needs you" (as on the portal). */
const needsYou = (a: Attention) => !a.seen_at && a.kind !== "reply";

type Glance = {
  id: string; title: string; sub: string; group: boolean;
  state: "working" | "stalled" | "queued" | "error" | "idle";
  needs: number; unread: boolean; since: string | null;
};

export function OverviewScreen({ navigation }: Props<"Overview">) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const now = useNow(15_000);
  const s = useStore();
  const pairing = usePairing();
  const { servers } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await s.refresh();
    setRefreshing(false);
  };

  const unseen = useMemo(() => (s.attention ?? []).filter(needsYou), [s.attention]);

  /** Every live task room and every group, with what's happening in it right now. */
  const glances: Glance[] = useMemo(() => {
    const prog = Object.values(s.progress ?? {});
    const attentionIn = (id: string) => (s.attention ?? []).filter((a) => a.room_id === id && !a.seen_at);
    const fromProgress = (list: Progress[]) => {
      const stalled = list.find((x) => x.state === "stalled");
      const top = stalled ?? list[0];
      return { top, stalled: !!stalled };
    };
    const rooms = s.work.live.filter((r) => !isHelperWork(r, s.agents)).map((r: WorkRoom): Glance => {
      const list = prog.filter((x) => x.root_id === r.root.id);
      const { top, stalled } = fromProgress(list);
      const st = roomStatus(r).key;
      const working = list.length > 0 || st === "working";
      const a = attentionIn(r.root.id);
      return {
        id: r.root.id, title: r.root.label ?? r.root.name, group: false,
        state: stalled ? "stalled" : working ? "working" : st === "queued" ? "queued" : st === "error" ? "error" : "idle",
        sub: top ? `${s.nameOf(top.agent_id) ?? r.root.name}: ${top.activity || top.step?.summary || "working"}`
          : working ? `${r.root.name}: ${r.root.current ?? "working"}` : st === "queued" ? "Up next" : st === "error" ? "Something went wrong" : "Waiting for you",
        needs: a.filter((x) => x.kind !== "reply").length, unread: a.some((x) => x.kind === "reply"),
        since: top?.started_at ?? r.last_activity,
      };
    });
    const groups = s.groups.map((g: Group): Glance => {
      const list = prog.filter((x) => x.group_id === g.id || x.root_id === g.id);
      const { top, stalled } = fromProgress(list);
      const a = attentionIn(g.id);
      return {
        id: g.id, title: `#${g.name}`, group: true,
        state: stalled ? "stalled" : list.length ? "working" : "idle",
        sub: top ? `${s.nameOf(top.agent_id) ?? "agent"}: ${top.activity || "working"}` : g.paused ? "Paused: waiting for your message" : g.purpose || "Group",
        needs: a.filter((x) => x.kind !== "reply").length, unread: a.some((x) => x.kind === "reply"),
        since: top?.started_at ?? null,
      };
    });
    // What needs you first, then what's working, then the rest.
    const rank = (x: Glance) => (x.needs ? 0 : x.state === "stalled" ? 1 : x.state === "working" ? 2 : x.unread ? 3 : x.state === "queued" ? 4 : 5);
    return [...rooms, ...groups].sort((a, b) => rank(a) - rank(b) || (b.since ?? "").localeCompare(a.since ?? ""));
  }, [s.work.live, s.agents, s.groups, s.progress, s.attention, s.nameOf]);

  const activeGroups = glances.filter((g) => g.group && (g.state !== "idle" || g.needs || g.unread));
  const shown = [...glances.filter((g) => !g.group), ...activeGroups].sort((a, b) => glances.indexOf(a) - glances.indexOf(b));
  const workingCount = glances.filter((g) => g.state === "working" || g.state === "stalled").length;

  const openAttention = (a: Attention) => {
    s.markSeen([a.id]);
    if (a.room_id) openRoom(navigation, s.groups, a.room_id);
  };

  return (
    <Screen>
      <View style={[st.bar, { borderColor: p.border }]}>
        <PulseDot color={s.connected ? p.ok : p.warn} size={7} pulse={!s.connected} />
        <T muted size={13} numberOfLines={1}>{s.connected ? "Live" : "Connecting…"}</T>
        <Pressable onPress={() => navigation.navigate("Servers")} accessibilityRole="button" hitSlop={8}
          accessibilityLabel={`agentbox: ${serverName(pairing)}. ${servers.length > 1 ? "Switch" : "Add another"}`}
          style={[st.server, { borderColor: p.border, backgroundColor: p.surface }]}>
          <T size={12} weight="600" numberOfLines={1} style={{ maxWidth: 140 }}>{serverName(pairing)}</T>
          <T size={12} muted>{servers.length > 1 ? "⇄" : "+"}</T>
        </Pressable>
        <View style={{ flex: 1 }} />
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

        {/* Needs you: one line until opened. */}
        <View style={[st.card, { backgroundColor: p.surface, borderColor: unseen.length ? p.bad : p.border }]}>
          <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}
            accessibilityLabel={unseen.length ? `${unseen.length} things need you` : "Nothing needs you"} style={st.needsHead}>
            {unseen.length ? <PulseDot color={p.bad} size={9} pulse /> : <PulseDot color={p.ok} size={9} />}
            <T weight="700" style={{ flex: 1 }}>
              {s.attention === null ? "Needs you" : unseen.length ? "Needs you" : "Nothing needs you"}
            </T>
            {unseen.length > 0 && <Badge n={unseen.length} color={p.bad} />}
            <Text style={{ color: p.muted, fontSize: 14, marginLeft: 6 }}>{open ? "▾" : "▸"}</Text>
          </Pressable>
          {open && (
            <View style={{ gap: 6, marginTop: 6 }}>
              {s.attention === null ? (
                <T muted size={13}>Not available from this agentbox yet.</T>
              ) : unseen.length === 0 ? (
                <T muted size={13}>You're all caught up.</T>
              ) : (
                <>
                  {unseen.slice(0, 30).map((a) => (
                    <Pressable key={a.id} onPress={() => openAttention(a)} accessibilityRole="button" accessibilityLabel={a.title}
                      style={({ pressed }) => [st.needRow, { borderColor: p.border, opacity: pressed ? 0.7 : 1 }]}>
                      <Dot color={a.kind === "failed" ? p.bad : a.kind === "stalled" ? p.warn : p.accent} size={9} />
                      <View style={{ flex: 1 }}>
                        <T size={14} weight="600" numberOfLines={2}>{a.title}</T>
                        <T muted size={12}>{KIND[a.kind] ?? a.kind} · {relTime(a.created_at)}</T>
                      </View>
                      <Pressable onPress={() => s.markSeen([a.id])} accessibilityRole="button" accessibilityLabel="Mark seen" hitSlop={10} style={st.seen}>
                        <Text style={{ color: p.muted, fontSize: 16 }}>✓</Text>
                      </Pressable>
                    </Pressable>
                  ))}
                  {unseen.length > 1 && <Button small variant="ghost" label="Mark all seen" onPress={() => s.markSeen(unseen.map((a) => a.id))} />}
                </>
              )}
            </View>
          )}
        </View>

        {!!s.runs?.length && (
          <View style={{ gap: 8, marginTop: 6 }}>
            <SectionHead title="Routines running" right={<PulseDot color={p.accent} size={7} pulse />} />
            {s.runs.map((r) => (
              <RunCard key={r.id} run={r} progress={runProgress(s.progress, r.id)} now={now}
                onPress={() => navigation.navigate("Run", { id: r.id, title: r.routine_name })} />
            ))}
          </View>
        )}

        <View style={{ gap: 8, marginTop: 6 }}>
          <SectionHead title="Work" right={<T muted size={12}>{workingCount ? `${workingCount} in progress` : "nothing running"}</T>}
            action={{ label: "All work", onPress: () => navigation.navigate("Work") }} />
          {shown.length === 0 ? (
            <T muted size={13}>{s.workLoaded ? "No work yet. Start a task below." : "Loading…"}</T>
          ) : shown.map((g) => {
            const color = g.state === "stalled" ? p.warn : g.state === "working" ? p.accent : g.state === "error" ? p.bad : g.state === "queued" ? p.warn : p.muted;
            return (
              <Pressable key={g.id} onPress={() => openRoom(navigation, s.groups, g.id, g.title)} accessibilityRole="button"
                accessibilityLabel={`${g.title}. ${STATE[g.state]}${g.needs ? `. ${g.needs} need you` : ""}${g.unread ? ". New reply" : ""}`}
                style={({ pressed }) => [st.row, { backgroundColor: p.surface, borderColor: g.needs ? p.bad : p.border, opacity: pressed ? 0.8 : 1 }]}>
                <PulseDot color={color} size={10} pulse={g.state === "working" || g.state === "stalled"} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="600" numberOfLines={1}>{g.title}</T>
                  <T muted size={12} numberOfLines={1}>
                    {g.state === "working" || g.state === "stalled" ? (g.since ? `${elapsed(g.since, now)} · ` : "") : ""}{g.sub}
                  </T>
                </View>
                {g.needs > 0 ? <Badge n={g.needs} color={p.bad} /> : g.unread ? <View style={[st.unread, { backgroundColor: p.accent }]} /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <View style={[st.fab, { bottom: 24 + insets.bottom }]}>
        <Button variant="primary" label="+ New task" onPress={() => navigation.navigate("NewTask")} />
      </View>
    </Screen>
  );
}

const KIND: Record<string, string> = { reply: "Replied", failed: "Blocked: failed", stalled: "Blocked: may be stuck", question: "Needs your input" };
const STATE: Record<Glance["state"], string> = { working: "In progress", stalled: "May be stuck", queued: "Up next", error: "Error", idle: "Waiting" };

function SectionHead({ title, right, action }: { title: string; right?: React.ReactNode; action?: { label: string; onPress: () => void } }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <T muted weight="600" size={13}>{title.toUpperCase()}</T>
      {right}
      {action && (
        <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8} style={{ marginLeft: "auto" }}>
          <T size={13} weight="600" style={{ color: p.accent }}>{action.label}</T>
        </Pressable>
      )}
    </View>
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
  bar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  paused: { marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10, borderWidth: 1, gap: 2 },
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  needsHead: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36 },
  needRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  unread: { width: 10, height: 10, borderRadius: 5 },
  seen: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  server: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 4 },
  usage: { flexDirection: "row", alignItems: "center", gap: 5 },
  fab: { position: "absolute", right: 16 },
});
