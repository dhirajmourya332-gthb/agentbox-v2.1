import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { showDialog } from "../ui/dialog";
import { ActivityIndicator, KeyboardAvoidingView, StyleSheet, Text, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { InstanceSummary, Message, RoomView, Step, Task } from "../lib/types";
import { useAttachments } from "../ui/Attachments";
import { ChatList, type ChatListHandle } from "../ui/ChatList";
import { Composer } from "../ui/Composer";
import { Button, Dot, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import {
  DocumentsList, entryFromProgress, entryFromTask, FilterChip, LiveBars, MembersSheet, MemberStack, type LiveEntry, type MemberRow,
} from "../ui/Live";
import { buildRows, isMessageRow, isMineRow, TimelineItem, type TimelineRow } from "../ui/Timeline";
import { statusColor, usePalette } from "../ui/theme";
import { useVoice } from "../ui/Voice";

/**
 * A task room: the lead task and every task it started, as one timeline (like the portal's Room).
 * The composer talks to the room's lead task thread. Header: members (with live status and a
 * per-member filter). Tabs: conversation and documents.
 */

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
  const chat = useRef<ChatListHandle>(null);

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

  const threadAgent = useCallback((tid: string) => byThread.get(tid), [byThread]);
  const taskOf = useCallback((tid: string) => taskById.get(tid), [taskById]);
  const rows: TimelineRow[] = useMemo(
    () => buildRows(merged.msgs, merged.tasks, filter, threadAgent),
    [merged, filter, threadAgent],
  );

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
          <ChatList
            ref={chat}
            data={rows}
            isMessage={isMessageRow}
            isMine={isMineRow}
            resetKey={filter}
            footer={<RoomHeader root={root} members={members} />}
            renderItem={({ item }) => (
              <TimelineItem item={item} member={member} threadAgent={threadAgent} task={taskOf} steps={merged.steps} live={live} />
            )}
          />
          <LiveBars entries={liveEntries} steps={merged.steps} />
          {!done && rootThread && <RoomComposer threadId={rootThread} lead={root} onSent={() => chat.current?.scrollToBottom()} />}
          {done && <T muted size={13} style={{ textAlign: "center", padding: 16 }}>This task room is done; its history stays readable.</T>}
        </KeyboardAvoidingView>
      )}
      <MembersSheet visible={sheet} members={memberRows} filter={filter}
        onFilter={(f) => { setFilter(f); setTab("chat"); }} onClose={() => setSheet(false)} />
    </Screen>
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

function RoomComposer({ threadId, lead, onSent }: { threadId: string; lead: InstanceSummary; onSent: () => void }) {
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
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Composer text={text} setText={setText} att={att} voice={voice} onSend={send} busy={busy} error={error}
      placeholder={`Message ${lead.name}…`} inputLabel={`Message ${lead.name}, the room's lead`} sendLabel={`Send to ${lead.name}`} />
  );
}

const st = StyleSheet.create({
  tabs: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10, marginBottom: 4, gap: 4 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
