import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { showDialog } from "../ui/dialog";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { InstanceSummary, Message, RoomView, Step, Task } from "../lib/types";
import { AttachmentStrip, useAttachments } from "../ui/Attachments";
import { Button, Dot, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import {
  DocumentsList, entryFromProgress, entryFromTask, FilterChip, LiveBars, MembersSheet, MemberStack, type LiveEntry, type MemberRow,
} from "../ui/Live";
import { Markdown } from "../ui/Markdown";
import { relTime, statusColor, usePalette } from "../ui/theme";
import { MicButton, useVoice, VoiceBar } from "../ui/Voice";

/**
 * A task room: the lead task and every task it started, as one timeline (like the portal's Room).
 * The composer talks to the room's lead task thread. Header: members (with live status and a
 * per-member filter). Tabs: conversation and documents.
 */

type Row =
  | { kind: "msg"; id: string; m: Message }
  | { kind: "pending"; id: string; t: Task };

export function memberBadge(m: InstanceSummary): MemberRow["badge"] {
  if (m.status === "done" || m.retired_at) return "done";
  if (m.status === "working") return "working";
  if (m.queued > 0) return "queued";
  if (m.status === "error") return "error";
  if (m.status === "limited") return "limited";
  return "idle";
}

export function RoomScreen({ route, navigation }: Props<"Room">) {
  const { id } = route.params;
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const { threads, live, loadThread, work, progress, attention, markSeen, agents, nameOf } = useStore();
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "docs">("chat");
  const [sheet, setSheet] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  // Membership comes from the server; refetch when the work list changes for this room.
  const signature = JSON.stringify([...work.live, ...work.done].find((w) => w.root.id === id)?.members.map((m) => [m.id, m.status]) ?? []);
  const load = useCallback(() => {
    api.room(id)
      .then((v) => { setView(v); setError(null); v.threads.forEach((t) => { loadThread(t.id).catch(() => {}); }); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the room"));
  }, [id, loadThread]);
  useEffect(load, [load, signature]);

  // Opening a room marks its "needs you" items seen (like the portal).
  const unseenHere = (attention ?? []).filter((a) => !a.seen_at && a.room_id === id).map((a) => a.id);
  const unseenKey = unseenHere.join(",");
  useEffect(() => {
    if (unseenHere.length) markSeen(unseenHere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseenKey, markSeen]);

  const members = useMemo(() => (view ? [view.root, ...view.members.filter((m) => m.id !== view.root.id)] : []), [view]);
  const member = useCallback((iid: string | undefined) => members.find((m) => m.id === iid), [members]);
  const byThread = useMemo(() => new Map((view?.threads ?? []).map((t) => [t.id, t.agent_id])), [view]);

  const merged = useMemo(() => {
    const msgs: Message[] = []; const tasks: Task[] = []; const steps: Step[] = [];
    for (const t of view?.threads ?? []) {
      const d = threads[t.id];
      if (!d) continue;
      msgs.push(...d.messages); tasks.push(...d.tasks); steps.push(...d.steps);
    }
    msgs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { msgs, tasks, steps };
  }, [view, threads]);
  const taskById = useMemo(() => new Map(merged.tasks.map((t) => [t.id, t])), [merged]);
  const running = merged.tasks.filter((t) => t.status === "running");

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const progressOf = useCallback(
    (iid: string) => Object.values(progress ?? {}).find((x) => x.agent_id === iid),
    [progress],
  );

  const rows: Row[] = useMemo(() => {
    const replied = new Set(merged.msgs.map((m) => m.task_id).filter(Boolean));
    const pending = merged.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
    const keep = (m: Message) => !filter || m.author === filter || byThread.get(m.thread_id) === filter;
    const list: Row[] = [
      ...merged.msgs.filter(keep).map((m) => ({ kind: "msg" as const, id: m.id, m })),
      ...pending.filter((t) => !filter || t.agent_id === filter).map((t) => ({ kind: "pending" as const, id: `p-${t.id}`, t })),
    ];
    return list.reverse(); // inverted list: newest first
  }, [merged, filter, byThread]);

  const memberRows: MemberRow[] = useMemo(() => members.map((m) => {
    const role = agents.find((a) => a.id === m.role_id);
    return {
      id: m.id, name: m.name,
      role: [role?.title || role?.name, m.label].filter(Boolean).join(" · ") || "Agent",
      color: m.color, badge: memberBadge(m), current: progressOf(m.id)?.activity ?? m.current,
      lead: m.id === view?.root.id, indent: !!m.parent_instance_id,
    };
  }), [members, agents, progressOf, view]);

  const liveEntries: LiveEntry[] = useMemo(() => {
    if (progress) {
      return Object.values(progress)
        .filter((x) => memberIds.has(x.agent_id))
        .map((x) => entryFromProgress(x, member(x.agent_id)?.name ?? nameOf(x.agent_id) ?? "agent", member(x.agent_id)?.color));
    }
    return running.map((t) => entryFromTask(t, merged.steps, member(t.agent_id)?.name ?? "agent", member(t.agent_id)?.color));
  }, [progress, memberIds, member, nameOf, running, merged.steps]);

  const root = view?.root;
  const done = !!root?.retired_at;

  const stopAll = useCallback(() => {
    showDialog("Stop?", `Stop ${running.length} running task${running.length === 1 ? "" : "s"} in this room?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => running.forEach((t) => { api.stop(t.id).catch((e: unknown) => showDialog("Couldn't stop", e instanceof Error ? e.message : "")); }) },
    ]);
  }, [running]);

  const markDone = useCallback(() => {
    if (!root) return;
    showDialog("Mark the whole room done?", `Finishes ${root.label ?? root.name} and every task in it. History stays.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Mark done", onPress: () => { api.finishTask(root.id).then(load, (e: unknown) => showDialog("Couldn't finish", e instanceof Error ? e.message : "")); } },
    ]);
  }, [root, load]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: root ? root.label ?? root.name : route.params.title ?? "Task",
      headerRight: () => (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          {memberRows.length > 0 && <MemberStack members={memberRows} onPress={() => setSheet(true)} />}
          {running.length > 0 && <Button small variant="danger" label="Stop" onPress={stopAll} />}
          {root && !done && <Button small label="Done" onPress={markDone} />}
        </View>
      ),
    });
  }, [navigation, root, done, running.length, stopAll, markDone, route.params.title, memberRows]);

  if (error && !view) return <Screen style={{ padding: 16 }}><ErrorBox text={error} /></Screen>;
  if (!view || !root) return <Screen style={{ justifyContent: "center" }}><ActivityIndicator color={p.muted} /></Screen>;

  const rootThread = view.threads.find((t) => t.agent_id === root.id && t.kind === "dm")?.id;

  const authorName = (m: Message) => {
    if (m.author === "user") return "You";
    if (m.author === "routine") return "Routine";
    return member(m.author)?.name ?? "agent";
  };
  const filtered = filter ? member(filter) : undefined;

  return (
    <Screen>
      <View style={st.tabs}>
        <Segmented value={tab} onChange={setTab} options={[{ key: "chat", label: "Conversation" }, { key: "docs", label: "Documents" }]} />
      </View>
      {tab === "docs" ? (
        <DocumentsList load={() => api.roomDocuments(root.id)} nameOf={(a) => member(a)?.name ?? nameOf(a)}
          onOpen={(d) => navigation.navigate("Doc", { path: d.path, name: d.name })} empty="No documents in this room yet." />
      ) : (
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
          {filtered && <FilterChip name={filtered.label ?? filtered.name} onClear={() => setFilter(null)} />}
          <FlatList
            inverted
            data={rows}
            keyExtractor={(r) => r.id}
            contentContainerStyle={{ padding: 14, gap: 14 }}
            ListFooterComponent={<RoomHeader root={root} members={members} />}
            renderItem={({ item }) => {
              if (item.kind === "pending") {
                const t = item.t;
                const inst = member(t.agent_id);
                const steps = merged.steps.filter((s) => s.task_id === t.id);
                const last = steps[steps.length - 1];
                return (
                  <View style={st.msg}>
                    <Meta name={inst?.name ?? "agent"} tag={inst?.label ?? undefined} color={inst?.color} note={t.status === "queued" ? "up next" : "working…"} />
                    {t.status === "running" && last && <T muted size={13} numberOfLines={2}>{last.summary || last.name}</T>}
                    {t.status === "running" && (live[t.id] ? <Markdown text={live[t.id]} /> : <ActivityIndicator color={p.muted} style={{ alignSelf: "flex-start" }} />)}
                  </View>
                );
              }
              const m = item.m;
              const inst = member(byThread.get(m.thread_id));
              if (m.author === "system") {
                return <T muted size={13} style={{ textAlign: "center" }}>{inst ? `${inst.label ?? inst.name}: ` : ""}{m.content}</T>;
              }
              const task = m.task_id ? taskById.get(m.task_id) : undefined;
              const isReply = !!task && task.agent_id === m.author;
              const note = !isReply && task?.source === "agent" ? "handed off" : !isReply && task?.source === "result" ? "reported back" : undefined;
              const mine = m.author === "user";
              return (
                <View style={[st.msg, mine && { backgroundColor: p.surface2, borderRadius: 12, padding: 10 }]}>
                  <Meta name={authorName(m)} tag={inst?.label ?? undefined} color={mine ? undefined : member(m.author)?.color} note={note} time={m.created_at} />
                  <Markdown text={m.content} />
                </View>
              );
            }}
          />
          <LiveBars entries={liveEntries} steps={merged.steps} />
          {!done && rootThread && <Composer threadId={rootThread} lead={root} />}
          {done && <T muted size={13} style={{ textAlign: "center", padding: 16 }}>This task room is done; its history stays readable.</T>}
        </KeyboardAvoidingView>
      )}
      <MembersSheet visible={sheet} members={memberRows} filter={filter}
        onFilter={(f) => { setFilter(f); setTab("chat"); }} onClose={() => setSheet(false)} />
    </Screen>
  );
}

function Meta({ name, tag, color, note, time }: { name: string; tag?: string; color?: string; note?: string; time?: string }) {
  const p = usePalette();
  return (
    <View style={st.meta}>
      {color && <Dot color={color} size={8} />}
      <T weight="600" size={14}>{name}</T>
      {tag && tag !== name && <T muted size={12} numberOfLines={1} style={{ flexShrink: 1 }}>{tag}</T>}
      {note && <T muted size={12}>· {note}</T>}
      {time && <Text style={{ color: p.muted, fontSize: 12, marginLeft: "auto" }}>{relTime(time)}</Text>}
    </View>
  );
}

function RoomHeader({ root, members }: { root: InstanceSummary; members: InstanceSummary[] }) {
  const p = usePalette();
  return (
    <View style={[st.head, { borderColor: p.border }]}>
      <T muted size={13}>Task room · led by {root.name}</T>
      {members.map((m) => (
        <View key={m.id} style={st.memberRow}>
          <Dot color={statusColor(p, m.status)} size={8} />
          <T size={13} numberOfLines={1} style={{ flex: 1, paddingLeft: m.parent_instance_id ? 12 : 0 }}>
            {m.label ?? m.name} <Text style={{ color: p.muted }}>· {m.name}{m.current ? ` · ${m.current}` : m.status === "done" ? " · done" : ""}</Text>
          </T>
        </View>
      ))}
    </View>
  );
}

function Composer({ threadId, lead }: { threadId: string; lead: InstanceSummary }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments();
  const voice = useVoice({ purpose: "message", agentId: lead.id, setText });
  const can = (!!text.trim() || att.paths.length > 0) && !att.uploading && !busy && !voice.busy;

  const send = async () => {
    const v = text.trim();
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      await api.send(threadId, v, att.paths);
      setText("");
      att.clear();
      voice.dismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[st.composer, { borderColor: p.border, backgroundColor: p.surface, paddingBottom: 8 + insets.bottom }]}>
      <AttachmentStrip a={att} />
      <VoiceBar v={voice} />
      {error && <Text style={{ color: p.bad, fontSize: 13, marginBottom: 4 }}>{error}</Text>}
      <View style={st.composerRow}>
        <Pressable onPress={() => { att.pick().catch(() => setError("Couldn't open the photo picker")); }} accessibilityRole="button" accessibilityLabel="Attach images"
          style={[st.attach, { borderColor: p.border }]} hitSlop={6}>
          <Text style={{ color: p.text, fontSize: 20 }}>＋</Text>
        </Pressable>
        <MicButton v={voice} />
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={`Message ${lead.name}…`}
          placeholderTextColor={p.muted}
          accessibilityLabel="Message the room's lead"
          style={[st.input, { color: p.text, backgroundColor: p.surface2 }]}
        />
        <Button small variant="primary" label="Send" onPress={send} disabled={!can} busy={busy} />
      </View>
      <T muted size={12}>{att.uploading ? "Uploading image…" : `Goes to ${lead.name} (${lead.label ?? "lead"}), who coordinates the room.`}</T>
    </View>
  );
}

export const composerStyles = StyleSheet.create({
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, gap: 4 },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  attach: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
});

const st = StyleSheet.create({
  ...composerStyles,
  tabs: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  msg: { gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10, marginBottom: 4, gap: 4 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
