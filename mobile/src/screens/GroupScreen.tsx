import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Agent, Group, Message, Task } from "../lib/types";
import { useAttachments } from "../ui/Attachments";
import { ChatList, type ChatListHandle } from "../ui/ChatList";
import { Composer } from "../ui/Composer";
import { showDialog } from "../ui/dialog";
import { Avatar, Button, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import {
  DocumentsList, entryFromProgress, entryFromTask, FilterChip, LiveBars, MembersSheet, MemberStack, type LiveEntry, type MemberRow,
} from "../ui/Live";
import { Markdown } from "../ui/Markdown";
import { relTime, usePalette } from "../ui/theme";
import { useVoice } from "../ui/Voice";

/**
 * A group: one shared conversation with several agents (the portal's GroupChat). The group's id
 * is its thread id. Read and post; @mention members to bring them in.
 */

type Row = { kind: "msg"; id: string; m: Message } | { kind: "pending"; id: string; t: Task };

const isMessage = (r: Row) => r.kind === "msg" && r.m.author !== "system";
const isMine = (r: Row) => r.kind === "msg" && r.m.author === "user";

export function GroupScreen({ route, navigation }: Props<"Group">) {
  const { id } = route.params;
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const { groups, agents, threads, live, loadThread, progress, attention, markSeen, nameOf, colorOf, loaded } = useStore();
  const group = groups.find((g) => g.id === id);
  const data = threads[id];
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "docs">("chat");
  const [sheet, setSheet] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const chat = useRef<ChatListHandle>(null);

  useEffect(() => {
    loadThread(id).then(() => setError(null), (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the group"));
  }, [id, loadThread]);

  const unseenHere = (attention ?? []).filter((a) => !a.seen_at && a.room_id === id).map((a) => a.id);
  const unseenKey = unseenHere.join(",");
  useEffect(() => {
    if (unseenHere.length) markSeen(unseenHere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseenKey, markSeen]);

  const members: Agent[] = useMemo(
    () => (group?.members ?? []).map((m) => agents.find((a) => a.id === m)).filter((a): a is Agent => !!a),
    [group, agents],
  );
  const lead = members.find((a) => a.id === group?.lead_agent_id) ?? members[0];
  const tasks = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  const running = (data?.tasks ?? []).filter((t) => t.status === "running");
  const groupProgress = useMemo(() => Object.values(progress ?? {}).filter((x) => x.group_id === id || x.root_id === id), [progress, id]);

  const memberRows: MemberRow[] = useMemo(() => members.map((a) => {
    const mine = (data?.tasks ?? []).filter((t) => t.agent_id === a.id);
    const run = mine.find((t) => t.status === "running");
    const queued = mine.some((t) => t.status === "queued");
    const pr = groupProgress.find((x) => x.agent_id === a.id);
    return {
      id: a.id, name: a.name, role: a.title || "Agent", color: a.color, lead: a.id === lead?.id,
      badge: run ? "working" : queued ? "queued" : a.status === "error" ? "error" : a.status === "limited" ? "limited" : "idle",
      current: pr?.activity ?? (run ? run.title ?? "Replying" : null),
    };
  }), [members, data, groupProgress, lead]);

  const liveEntries: LiveEntry[] = useMemo(() => {
    if (progress) return groupProgress.map((x) => entryFromProgress(x, nameOf(x.agent_id) ?? "agent", colorOf(x.agent_id)));
    return running.map((t) => entryFromTask(t, data?.steps ?? [], nameOf(t.agent_id) ?? "agent", colorOf(t.agent_id)));
  }, [progress, groupProgress, running, data, nameOf, colorOf]);

  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const replied = new Set(data.messages.map((m) => m.task_id).filter(Boolean));
    const pending = data.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
    const list: Row[] = [
      ...data.messages.filter((m) => !filter || m.author === filter).map((m) => ({ kind: "msg" as const, id: m.id, m })),
      ...pending.filter((t) => !filter || t.agent_id === filter).map((t) => ({ kind: "pending" as const, id: `p-${t.id}`, t })),
    ];
    return list.reverse();
  }, [data, filter]);

  const stopAll = useCallback(() => {
    showDialog("Stop?", `Stop ${running.length} running repl${running.length === 1 ? "y" : "ies"} in this group?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => running.forEach((t) => { api.stop(t.id).catch((e: unknown) => showDialog("Couldn't stop", e instanceof Error ? e.message : "")); }) },
    ]);
  }, [running]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: group ? `#${group.name}` : route.params.title ? `#${route.params.title}` : "Group",
      headerRight: () => (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          {memberRows.length > 0 && <MemberStack members={memberRows} onPress={() => setSheet(true)} />}
          {running.length > 0 && <Button small variant="danger" label="Stop" onPress={stopAll} />}
        </View>
      ),
    });
  }, [navigation, group, route.params.title, memberRows, running.length, stopAll]);

  if (loaded && !group) return <Screen style={{ padding: 16 }}><ErrorBox text="This group doesn't exist any more." /></Screen>;
  if (!group) return <Screen style={{ justifyContent: "center" }}><ActivityIndicator color={p.muted} /></Screen>;
  const filtered = filter ? members.find((a) => a.id === filter) : undefined;

  return (
    <Screen>
      <View style={st.tabs}>
        <Segmented value={tab} onChange={setTab} options={[{ key: "chat", label: "Conversation" }, { key: "docs", label: "Documents" }]} />
      </View>
      {tab === "docs" ? (
        <DocumentsList load={() => api.groupDocuments(group.id)} nameOf={nameOf}
          onOpen={(d) => navigation.navigate("Doc", { path: d.path, name: d.name })} empty="No documents from this group yet." />
      ) : (
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
          {filtered && <FilterChip name={filtered.name} onClear={() => setFilter(null)} />}
          {error && !data && <View style={{ padding: 16 }}><ErrorBox text={error} /></View>}
          {!data && !error ? <ActivityIndicator style={{ flex: 1 }} color={p.muted} /> : (
            <ChatList
              ref={chat}
              data={rows}
              isMessage={isMessage}
              isMine={isMine}
              resetKey={filter}
              footer={<Intro group={group} lead={lead} />}
              renderItem={({ item }) => {
                if (item.kind === "pending") {
                  const t = item.t;
                  const steps = (data?.steps ?? []).filter((s) => s.task_id === t.id);
                  const last = steps[steps.length - 1];
                  const name = nameOf(t.agent_id) ?? "agent";
                  if (t.status === "queued") return <T muted size={13} style={{ textAlign: "center" }}>{name} is up next</T>;
                  return (
                    <View style={st.msg}>
                      <Meta name={name} color={colorOf(t.agent_id)} note="replying…" />
                      {last && <T muted size={13} numberOfLines={2}>{last.summary || last.name}</T>}
                      {live[t.id] ? <Markdown text={live[t.id]} /> : <ActivityIndicator color={p.muted} style={{ alignSelf: "flex-start" }} />}
                    </View>
                  );
                }
                const m = item.m;
                if (m.author === "system") return <T muted size={13} style={{ textAlign: "center" }}>{m.content}</T>;
                const mine = m.author === "user";
                const task = m.task_id ? tasks.get(m.task_id) : undefined;
                return (
                  <View style={[st.msg, mine && { backgroundColor: p.surface2, borderRadius: 12, padding: 10 }]}>
                    <Meta name={mine ? "You" : nameOf(m.author) ?? "Deleted agent"} color={mine ? undefined : colorOf(m.author)}
                      note={!mine && m.author === group.lead_agent_id ? "lead" : undefined} time={m.created_at} />
                    {mine ? <T selectable>{m.content}</T> : <Markdown text={m.content} />}
                    {task?.status === "failed" && <T size={13} style={{ color: p.bad }}>✕ {task.error ?? "Failed"}</T>}
                  </View>
                );
              }}
            />
          )}
          {group.paused && (
            <View style={[st.paused, { backgroundColor: p.surface2 }]}>
              <T size={13} muted>Paused after 12 agent replies since your last message, so agents can't loop without you. Send a message to continue.</T>
            </View>
          )}
          <LiveBars entries={liveEntries} steps={data?.steps ?? []} />
          <GroupComposer group={group} members={members} lead={lead} onSent={() => chat.current?.scrollToBottom()} />
        </KeyboardAvoidingView>
      )}
      <MembersSheet visible={sheet} members={memberRows} filter={filter}
        onFilter={(f) => { setFilter(f); setTab("chat"); }} onClose={() => setSheet(false)} />
    </Screen>
  );
}

function Intro({ group, lead }: { group: Group; lead?: Agent }) {
  const p = usePalette();
  return (
    <View style={[st.intro, { borderColor: p.border }]}>
      <T weight="600">#{group.name}</T>
      {!!group.purpose && <T muted size={13}>{group.purpose}</T>}
      <T muted size={12}>
        @mention members to bring them in; a message without a mention goes to the lead{lead ? ` (${lead.name})` : ""}.
      </T>
    </View>
  );
}

function Meta({ name, color, note, time }: { name: string; color?: string; note?: string; time?: string }) {
  const p = usePalette();
  return (
    <View style={st.meta}>
      {color ? <Avatar name={name} color={color} size={18} /> : null}
      <T weight="600" size={14}>{name}</T>
      {note && <T muted size={12}>· {note}</T>}
      {time && <Text style={{ color: p.muted, fontSize: 12, marginLeft: "auto" }}>{relTime(time)}</Text>}
    </View>
  );
}

function GroupComposer({ group, members, lead, onSent }: { group: Group; members: Agent[]; lead?: Agent; onSent: () => void }) {
  const p = usePalette();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments();
  const voice = useVoice({ purpose: "message", agentId: lead?.id, setText });
  const can = (!!text.trim() || att.paths.length > 0) && !att.uploading && !busy && !voice.busy;

  // @mention picker: suggest members while typing "@na…".
  const partial = text.match(/@([A-Za-z0-9_-]*)$/)?.[1];
  const suggestions = partial === undefined ? [] : members.filter((a) => a.slug.startsWith(partial.toLowerCase())).slice(0, 6);
  const pick = (a: Agent) => setText((t) => t.replace(/@([A-Za-z0-9_-]*)$/, `@${a.slug} `));

  const send = async () => {
    const v = text.trim();
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      await api.send(group.id, v, att.paths);
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

  const mentions = suggestions.length > 0 && !voice.busy ? (
    <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingVertical: 4, paddingHorizontal: 4 }}>
      {suggestions.map((a) => (
        <Pressable key={a.id} onPress={() => pick(a)} accessibilityRole="button" accessibilityLabel={`Mention ${a.name}`}
          style={[st.suggest, { backgroundColor: p.surface, borderColor: p.border }]}>
          <Avatar name={a.name} color={a.color} size={18} />
          <T size={14}>@{a.slug}</T>
        </Pressable>
      ))}
    </ScrollView>
  ) : null;

  return (
    <Composer text={text} setText={setText} att={att} voice={voice} onSend={send} busy={busy} error={error} above={mentions}
      placeholder={`Message #${group.name} — @ to mention`} inputLabel={`Message #${group.name}. Type @ to mention a member`}
      sendLabel={`Send to #${group.name}`} />
  );
}

const st = StyleSheet.create({
  tabs: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  msg: { gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  intro: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10, marginBottom: 4, gap: 4 },
  paused: { marginHorizontal: 10, marginBottom: 6, padding: 10, borderRadius: 10 },
  suggest: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, minHeight: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth },
});
