import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Message, Task, Thread } from "../lib/types";
import { useAttachments } from "../ui/Attachments";
import { ChatList, type ChatListHandle } from "../ui/ChatList";
import { Composer } from "../ui/Composer";
import { showDialog } from "../ui/dialog";
import { Avatar, Button, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import { DocumentsList } from "../ui/Live";
import { Markdown } from "../ui/Markdown";
import { relTime, usePalette } from "../ui/theme";
import { NOT_AVAILABLE, useFetch } from "../ui/useFetch";
import { useVoice } from "../ui/Voice";

/**
 * One agent (the portal's agent chat): its own conversation, plus its hand-off and routine
 * threads, and its documents. You can message it directly, as on the web.
 */

type Row = { kind: "msg"; id: string; m: Message } | { kind: "pending"; id: string; t: Task };
const isMessage = (r: Row) => r.kind === "msg" && r.m.author !== "system";
const isMine = (r: Row) => r.kind === "msg" && r.m.author === "user";
const KIND: Record<Thread["kind"], string> = { dm: "Chat", handoff: "Hand-off", group: "Group", routine: "Routine" };

export function AgentScreen({ route, navigation }: Props<"Agent">) {
  const { id } = route.params;
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const { agents, threads, live, loadThread, nameOf, colorOf } = useStore();
  const agent = agents.find((a) => a.id === id);
  const list = useFetch(() => api.agentThreads(id));
  const [threadId, setThreadId] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "docs">("chat");
  const [error, setError] = useState<string | null>(null);
  const chat = useRef<ChatListHandle>(null);

  const shown = useMemo(
    () => (list.data ?? []).filter((t) => t.kind !== "group").sort((a, b) => (a.kind === "dm" ? -1 : b.kind === "dm" ? 1 : (b.last_at ?? "").localeCompare(a.last_at ?? ""))),
    [list.data],
  );
  useEffect(() => {
    if (!threadId && shown.length) setThreadId(shown[0].id);
  }, [shown, threadId]);
  useEffect(() => {
    if (!threadId) return;
    loadThread(threadId).then(() => setError(null), (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the conversation"));
  }, [threadId, loadThread]);

  const data = threadId ? threads[threadId] : undefined;
  const thread = shown.find((t) => t.id === threadId);
  const running = (data?.tasks ?? []).filter((t) => t.status === "running");
  const tasks = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);

  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const replied = new Set(data.messages.map((m) => m.task_id).filter(Boolean));
    const pending = data.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
    return [
      ...data.messages.map((m) => ({ kind: "msg" as const, id: m.id, m })),
      ...pending.map((t) => ({ kind: "pending" as const, id: `p-${t.id}`, t })),
    ].reverse();
  }, [data]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: agent?.name ?? route.params.title ?? "Agent",
      headerRight: () => running.length > 0 ? (
        <Button small variant="danger" label="Stop" onPress={() => showDialog("Stop?", `Stop ${agent?.name ?? "the agent"}'s running reply?`, [
          { text: "Cancel", style: "cancel" },
          { text: "Stop", style: "destructive", onPress: () => running.forEach((t) => { api.stop(t.id).catch((e: unknown) => showDialog("Couldn't stop", e instanceof Error ? e.message : "")); }) },
        ])} />
      ) : null,
    });
  }, [navigation, agent, route.params.title, running]);

  if (list.missing) return <Screen style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></Screen>;

  return (
    <Screen>
      <View style={st.tabs}>
        <Segmented value={tab} onChange={setTab} options={[{ key: "chat", label: "Conversation" }, { key: "docs", label: "Documents" }]} />
      </View>
      {tab === "docs" ? (
        <DocumentsList load={() => api.agentDocuments(id)} nameOf={nameOf}
          onOpen={(d) => navigation.navigate("Doc", { path: d.path, name: d.name })} empty={`No documents from ${agent?.name ?? "this agent"} yet.`} />
      ) : (
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
          {shown.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={st.chips}>
              {shown.map((t) => {
                const on = t.id === threadId;
                return (
                  <Pressable key={t.id} onPress={() => setThreadId(t.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
                    style={[st.chip, { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.surface2 : p.surface }]}>
                    <T size={13} weight={on ? "600" : "400"} numberOfLines={1}>
                      {t.kind === "dm" ? "Chat" : t.name ?? (t.peer_agent_id ? nameOf(t.peer_agent_id) : null) ?? KIND[t.kind]}
                    </T>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {(list.error || error) && !data && <View style={{ padding: 16 }}><ErrorBox text={(list.error ?? error)!} /></View>}
          {!data && !error && !list.error ? <ActivityIndicator style={{ flex: 1 }} color={p.muted} /> : data ? (
            <ChatList
              ref={chat}
              data={rows}
              isMessage={isMessage}
              isMine={isMine}
              resetKey={threadId}
              footer={agent ? (
                <View style={[st.intro, { borderColor: p.border }]}>
                  <T weight="600">{agent.name}</T>
                  <T muted size={13}>{agent.title}{thread && thread.kind !== "dm" ? ` · ${KIND[thread.kind]} thread` : ""}</T>
                </View>
              ) : null}
              renderItem={({ item }) => {
                if (item.kind === "pending") {
                  const t = item.t;
                  const steps = (data?.steps ?? []).filter((s) => s.task_id === t.id);
                  const step = steps[steps.length - 1];
                  const name = nameOf(t.agent_id) ?? "agent";
                  if (t.status === "queued") return <T muted size={13} style={{ textAlign: "center" }}>{name} will reply next</T>;
                  return (
                    <View style={st.msg}>
                      <Meta name={name} color={colorOf(t.agent_id)} note="replying…" />
                      {step && <T muted size={13} numberOfLines={2}>{step.summary || step.name}</T>}
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
                    <Meta name={mine ? "You" : nameOf(m.author) ?? "Agent"} color={mine ? undefined : colorOf(m.author)} time={m.created_at} />
                    {mine ? <T selectable>{m.content}</T> : <Markdown text={m.content} />}
                    {task?.status === "failed" && <T size={13} style={{ color: p.bad }}>✕ {task.error ?? "Failed"}</T>}
                  </View>
                );
              }}
            />
          ) : null}
          {thread?.kind === "dm" && agent && <AgentComposer threadId={thread.id} agentId={agent.id} name={agent.name} onSent={() => chat.current?.scrollToBottom()} />}
        </KeyboardAvoidingView>
      )}
    </Screen>
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

function AgentComposer({ threadId, agentId, name, onSent }: { threadId: string; agentId: string; name: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments();
  const voice = useVoice({ purpose: "message", agentId, setText });
  const can = (!!text.trim() || att.paths.length > 0) && !att.uploading && !busy && !voice.busy;

  const send = async () => {
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      await api.send(threadId, text.trim(), att.paths);
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
      placeholder={`Message ${name}…`} inputLabel={`Message ${name}`} sendLabel={`Send to ${name}`} />
  );
}

const st = StyleSheet.create({
  tabs: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  chips: { gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5, maxWidth: 200 },
  msg: { gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  intro: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10, marginBottom: 4, gap: 2 },
});
