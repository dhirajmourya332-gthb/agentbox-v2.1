import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { Message, Step, Task } from "../lib/types";
import { Dot, T } from "./kit";
import { Markdown } from "./Markdown";
import { relTime, usePalette } from "./theme";

/**
 * One row of a task-room style timeline (rooms and routine runs): a message, or a "working…"
 * placeholder for a task that hasn't replied yet. Rendered inside ChatList (newest first).
 */

export type TimelineRow =
  | { kind: "msg"; id: string; m: Message }
  | { kind: "pending"; id: string; t: Task };

/** What a row needs to know about an author (an InstanceSummary fits). */
export type TimelineMember = { name: string; label?: string | null; color?: string };

export const isMessageRow = (r: TimelineRow) => r.kind === "msg" && r.m.author !== "system";
export const isMineRow = (r: TimelineRow) => r.kind === "msg" && r.m.author === "user";

/** Messages (oldest first in, newest first out) plus a placeholder per open task without a reply. */
export function buildRows(
  msgs: Message[], tasks: Task[], filter: string | null = null, threadAgent?: (threadId: string) => string | undefined,
): TimelineRow[] {
  const replied = new Set(msgs.map((m) => m.task_id).filter(Boolean));
  const pending = tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
  const keep = (m: Message) => !filter || m.author === filter || threadAgent?.(m.thread_id) === filter;
  const list: TimelineRow[] = [
    ...msgs.filter(keep).map((m) => ({ kind: "msg" as const, id: m.id, m })),
    ...pending.filter((t) => !filter || t.agent_id === filter).map((t) => ({ kind: "pending" as const, id: `p-${t.id}`, t })),
  ];
  return list.reverse(); // inverted list: newest first
}

export function TimelineItem({ item, member, threadAgent, task, steps, live }: {
  item: TimelineRow;
  member: (id: string | undefined) => TimelineMember | undefined;
  threadAgent: (threadId: string) => string | undefined;
  task: (id: string) => Task | undefined;
  steps: Step[];
  /** Streamed text so far, by task id. */
  live: Record<string, string>;
}) {
  const p = usePalette();
  if (item.kind === "pending") {
    const t = item.t;
    const inst = member(t.agent_id);
    const own = steps.filter((s) => s.task_id === t.id);
    const last = own[own.length - 1];
    return (
      <View style={st.msg}>
        <Meta name={inst?.name ?? "agent"} tag={inst?.label ?? undefined} color={inst?.color} note={t.status === "queued" ? "up next" : "working…"} />
        {t.status === "running" && last && <T muted size={13} numberOfLines={2}>{last.summary || last.name}</T>}
        {t.status === "running" && (live[t.id] ? <Markdown text={live[t.id]} /> : <ActivityIndicator color={p.muted} style={{ alignSelf: "flex-start" }} />)}
      </View>
    );
  }
  const m = item.m;
  const inst = member(threadAgent(m.thread_id));
  if (m.author === "system") {
    return <T muted size={13} style={{ textAlign: "center" }}>{inst ? `${inst.label ?? inst.name}: ` : ""}{m.content}</T>;
  }
  const tk = m.task_id ? task(m.task_id) : undefined;
  const isReply = !!tk && tk.agent_id === m.author;
  const note = !isReply && tk?.source === "agent" ? "handed off" : !isReply && tk?.source === "result" ? "reported back" : undefined;
  const mine = m.author === "user";
  const name = mine ? "You" : m.author === "routine" ? "Routine" : member(m.author)?.name ?? "agent";
  return (
    <View style={[st.msg, mine && { backgroundColor: p.surface2, borderRadius: 12, padding: 10 }]}>
      <Meta name={name} tag={inst?.label ?? undefined} color={mine ? undefined : member(m.author)?.color} note={note} time={m.created_at} />
      <Markdown text={m.content} />
    </View>
  );
}

export function Meta({ name, tag, color, note, time }: { name: string; tag?: string; color?: string; note?: string; time?: string }) {
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

const st = StyleSheet.create({
  msg: { gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
});
