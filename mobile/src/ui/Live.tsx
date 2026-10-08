import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DocumentInfo, Progress, Step, Task } from "../lib/types";
import { Avatar, Badge, Dot, ErrorBox, T } from "./kit";
import { duration, elapsed, relTime, statusColor, useNow, usePalette } from "./theme";

/**
 * Shared pieces for rooms and groups: the live status bar per working member (contract A), the
 * Members sheet and the Documents list.
 */

export type LiveEntry = {
  taskId: string; name: string; color?: string; activity: string; startedAt: string | null;
  stalled: boolean; stalledFor: number | null; summary: string | null;
};

export function entryFromProgress(p: Progress, name: string, color?: string): LiveEntry {
  return {
    taskId: p.task_id, name, color, activity: p.activity || p.step?.summary || "Working",
    startedAt: p.started_at, stalled: p.state === "stalled", stalledFor: p.stalled_for_s, summary: p.summary,
  };
}

/** Without contract A on the server: what we can tell from the running task and its last step. */
export function entryFromTask(t: Task, steps: Step[], name: string, color?: string): LiveEntry {
  const last = steps.filter((s) => s.task_id === t.id).at(-1);
  return {
    taskId: t.id, name, color, activity: last ? last.summary || last.name : "Thinking",
    startedAt: t.started_at, stalled: false, stalledFor: null, summary: null,
  };
}

/** One line per working member; tap to see its recent steps. */
export function LiveBars({ entries, steps }: { entries: LiveEntry[]; steps: Step[] }) {
  const p = usePalette();
  const now = useNow(10_000);
  const [open, setOpen] = useState<string | null>(null);
  if (!entries.length) return null;
  return (
    <View style={[st.bars, { borderColor: p.border, backgroundColor: p.surface }]}>
      {entries.map((e) => {
        const expanded = open === e.taskId;
        const recent = expanded ? steps.filter((s) => s.task_id === e.taskId).slice(-8) : [];
        return (
          <View key={e.taskId}>
            <Pressable onPress={() => setOpen(expanded ? null : e.taskId)} accessibilityRole="button" accessibilityState={{ expanded }}
              accessibilityLabel={`${e.name}: ${e.activity}${e.stalled ? ", possibly stuck" : ""}. ${expanded ? "Hide" : "Show"} recent steps`}
              style={st.bar}>
              <Dot color={e.stalled ? p.warn : p.accent} size={8} />
              <T size={13} weight="600" numberOfLines={1} style={{ maxWidth: "35%" }}>{e.name}</T>
              <T size={13} muted numberOfLines={1} style={{ flex: 1 }}>{e.activity}</T>
              {e.stalled
                ? <T size={12} weight="600" style={{ color: p.warn }}>Possibly stuck{e.stalledFor ? ` · ${duration(e.stalledFor)}` : ""}</T>
                : <T size={12} muted>{elapsed(e.startedAt, now)}</T>}
              <Text style={{ color: p.muted, fontSize: 11 }}>{expanded ? "▴" : "▾"}</Text>
            </Pressable>
            {expanded && (
              <View style={st.steps}>
                {e.summary && <T size={13} style={{ marginBottom: 4 }}>{e.summary}</T>}
                {recent.length === 0 && <T muted size={12}>No steps yet.</T>}
                {recent.map((s) => (
                  <View key={s.id} style={st.step}>
                    <Text style={{ color: s.status === "error" ? p.bad : s.status === "running" ? p.accent : p.muted, fontSize: 12, width: 14 }}>
                      {s.status === "running" ? "●" : s.status === "error" ? "✕" : "✓"}
                    </Text>
                    <T size={12} muted numberOfLines={2} style={{ flex: 1 }}>
                      <Text style={{ color: p.text, fontWeight: "600" }}>{s.name}</Text>{s.summary ? ` ${s.summary}` : ""}
                    </T>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// --- Members sheet ----------------------------------------------------------------------------

export type MemberBadge = "working" | "queued" | "idle" | "done" | "error" | "limited";
export type MemberRow = { id: string; name: string; role: string; color?: string; badge: MemberBadge; current: string | null; lead?: boolean; indent?: boolean };

const BADGE_LABEL: Record<MemberBadge, string> = {
  working: "Working", queued: "Queued", idle: "Idle", done: "Done", error: "Error", limited: "Rate-limited",
};

export function MembersSheet({ visible, members, filter, onFilter, onClose }: {
  visible: boolean; members: MemberRow[]; filter: string | null; onFilter: (id: string | null) => void; onClose: () => void;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel="Close members">
        <Pressable style={[st.sheet, { backgroundColor: p.surface, borderColor: p.border, paddingBottom: 16 + insets.bottom }]} onPress={() => {}}>
          <View style={st.sheetHead}>
            <T size={17} weight="700" style={{ flex: 1 }}>Members</T>
            {filter && (
              <Pressable onPress={() => { onFilter(null); onClose(); }} accessibilityRole="button" hitSlop={8}>
                <T size={14} weight="600" style={{ color: p.accent }}>Show everyone</T>
              </Pressable>
            )}
          </View>
          <T muted size={12}>Tap a member to show only their part of the conversation.</T>
          <FlatList
            data={members}
            keyExtractor={(m) => m.id}
            style={{ maxHeight: 460 }}
            renderItem={({ item: m }) => {
              const on = filter === m.id;
              return (
                <Pressable onPress={() => { onFilter(on ? null : m.id); onClose(); }} accessibilityRole="button" accessibilityState={{ selected: on }}
                  accessibilityLabel={`${m.name}, ${m.role}, ${BADGE_LABEL[m.badge]}${m.current ? `, ${m.current}` : ""}`}
                  style={[st.member, { borderColor: p.border, backgroundColor: on ? p.surface2 : "transparent", paddingLeft: m.indent ? 22 : 8 }]}>
                  <Avatar name={m.name} color={m.color} size={34} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <T weight="600" numberOfLines={1}>{m.name}{m.lead ? <Text style={{ color: p.muted, fontWeight: "400" }}>  · lead</Text> : null}</T>
                    <T muted size={13} numberOfLines={1}>{m.role}</T>
                    {m.current && <T size={13} numberOfLines={2}>{m.current}</T>}
                  </View>
                  <Badge label={BADGE_LABEL[m.badge]} color={statusColor(p, m.badge)} />
                </Pressable>
              );
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Header button: up to three overlapping avatars and a count. Opens the Members sheet. */
export function MemberStack({ members, onPress }: { members: MemberRow[]; onPress: () => void }) {
  const p = usePalette();
  const working = members.some((m) => m.badge === "working");
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Members: ${members.length}`} hitSlop={6}
      style={({ pressed }) => [st.stack, { borderColor: p.border, backgroundColor: p.surface2, opacity: pressed ? 0.7 : 1 }]}>
      {members.slice(0, 3).map((m, i) => (
        <View key={m.id} style={{ marginLeft: i ? -8 : 0, borderRadius: 12, borderWidth: 1.5, borderColor: p.surface2 }}>
          <Avatar name={m.name} color={m.color} size={20} />
        </View>
      ))}
      <T size={13} weight="600" style={{ marginLeft: 4 }}>{members.length}</T>
      {working && <Dot color={p.accent} size={6} />}
    </Pressable>
  );
}

/** The chip shown above a filtered timeline. */
export function FilterChip({ name, onClear }: { name: string; onClear: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onClear} accessibilityRole="button" accessibilityLabel={`Showing ${name} only. Show everyone`}
      style={[st.chip, { backgroundColor: p.surface2, borderColor: p.border }]}>
      <T size={13}>Showing <Text style={{ fontWeight: "600" }}>{name}</Text> only</T>
      <T size={13} weight="600" style={{ color: p.accent }}>✕</T>
    </Pressable>
  );
}

// --- Documents --------------------------------------------------------------------------------

export function DocumentsList({ load, nameOf, onOpen, empty }: {
  load: () => Promise<DocumentInfo[]>; nameOf: (id: string) => string | undefined;
  onOpen: (d: DocumentInfo) => void; empty: string;
}) {
  const p = usePalette();
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDocs = () =>
    load()
      .then((d) => { setDocs([...d].sort((a, b) => b.modified.localeCompare(a.modified))); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the documents"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchDocs(); }, []);

  if (error && !docs) return <View style={{ padding: 16 }}><ErrorBox text={error} /></View>;
  if (!docs) return <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />;
  return (
    <FlatList
      data={docs}
      keyExtractor={(d) => d.path}
      contentContainerStyle={{ padding: 16, gap: 8 }}
      refreshing={refreshing}
      onRefresh={async () => { setRefreshing(true); await fetchDocs(); setRefreshing(false); }}
      ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>{empty}</T>}
      renderItem={({ item: d }) => {
        const author = d.author ? nameOf(d.author) : undefined;
        return (
          <Pressable onPress={() => onOpen(d)} accessibilityRole="button" accessibilityLabel={`Open ${d.name}`}
            style={({ pressed }) => [st.doc, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}>
            <Text style={{ fontSize: 18 }}>{docIcon(d.name)}</Text>
            <View style={{ flex: 1 }}>
              <T weight="600" numberOfLines={1}>{d.name}</T>
              <T muted size={12} numberOfLines={1}>{[author, relTime(d.modified), d.location].filter(Boolean).join(" · ")}</T>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

export type DocKind = "markdown" | "text" | "image" | "other";
export function docKind(name: string): DocKind {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["txt", "csv", "tsv", "rst", "adoc", "log", "json", "yaml", "yml"].includes(ext)) return "text";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return "other";
}
const docIcon = (name: string) => ({ markdown: "📝", text: "📄", image: "🖼️", other: "📎" })[docKind(name)];

const st = StyleSheet.create({
  bars: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 4 },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, minHeight: 36 },
  steps: { paddingLeft: 16, paddingBottom: 6, gap: 3 },
  step: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 8 },
  sheetHead: { flexDirection: "row", alignItems: "center" },
  member: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingRight: 8, borderRadius: 10 },
  chip: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, marginTop: 8 },
  stack: { flexDirection: "row", alignItems: "center", gap: 2, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 3 },
  doc: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
});
