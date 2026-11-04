import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, TextInput, View } from "react-native";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Note } from "../lib/types";
import { showDialog } from "./dialog";
import { Button, Card, ErrorBox, T } from "./kit";
import { relTime, usePalette } from "./theme";
import { NOT_AVAILABLE, useFetch } from "./useFetch";

/**
 * A task's notebook (the portal's Notes panel): your own plain-text notes kept beside the work.
 * Owner only; agents never read them. Add, edit and delete; live when a note changes elsewhere.
 */
export function NotesPanel({ instanceId }: { instanceId: string }) {
  const p = usePalette();
  const { subscribe, nameOf } = useStore();
  const f = useFetch(() => api.notes(instanceId));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const roomId = f.data?.room_id;
  useEffect(() => subscribe((e) => { if (e.type === "notes.updated" && e.roomId === roomId) f.refresh(); }), [subscribe, roomId, f.refresh]);

  const add = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try { await api.addNote(instanceId, body); setText(""); await f.refresh(); } catch (e) { showDialog("Couldn't save the note", e instanceof Error ? e.message : ""); }
    setBusy(false);
  };
  const saveEdit = async () => {
    if (!editing) return;
    try { await api.updateNote(editing.id, editing.body); setEditing(null); await f.refresh(); } catch (e) { showDialog("Couldn't save the note", e instanceof Error ? e.message : ""); }
  };
  const remove = (n: Note) =>
    showDialog("Delete this note?", "It can't be brought back.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { api.deleteNote(n.id).then(() => f.refresh(), (e: unknown) => showDialog("Couldn't delete it", e instanceof Error ? e.message : "")); } },
    ]);

  if (f.missing) return <View style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></View>;
  if (!f.data) return <View style={{ padding: 16 }}>{f.error ? <ErrorBox text={f.error} /> : <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />}</View>;

  return (
    <FlatList
      data={f.data.notes}
      keyExtractor={(n) => n.id}
      contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
      refreshing={f.refreshing}
      onRefresh={f.pull}
      ListHeaderComponent={
        <View style={{ gap: 8, marginBottom: 4 }}>
          <TextInput value={text} onChangeText={setText} placeholder="Write a note for yourself…" placeholderTextColor={p.muted} multiline
            maxLength={20000} accessibilityLabel="New note"
            style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]} />
          <Button small variant="primary" label="Add note" onPress={add} busy={busy} disabled={!text.trim()} style={{ alignSelf: "flex-end" }} />
          <T muted size={12}>Only you see these; agents never read them.</T>
        </View>
      }
      ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 16 }}>No notes yet.</T>}
      renderItem={({ item: n }) => (
        <Card style={{ gap: 6 }}>
          {n.quote && (
            <View style={[st.quote, { borderColor: p.border }]}>
              <T muted size={13} selectable numberOfLines={8}>{n.quote}</T>
              {n.author && <T muted size={12}>— {n.author === "user" ? "you" : nameOf(n.author) ?? "an agent"}</T>}
            </View>
          )}
          {editing?.id === n.id ? (
            <>
              <TextInput value={editing.body} onChangeText={(body) => setEditing({ id: n.id, body })} multiline autoFocus maxLength={20000}
                accessibilityLabel="Edit note" style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface2 }]} />
              <View style={st.row}>
                <Button small label="Cancel" onPress={() => setEditing(null)} style={{ flex: 1 }} />
                <Button small variant="primary" label="Save" onPress={saveEdit} style={{ flex: 1 }} />
              </View>
            </>
          ) : (
            <>
              {!!n.body && <T selectable>{n.body}</T>}
              <View style={st.row}>
                <T muted size={12} style={{ flex: 1 }}>{relTime(n.updated_at)}</T>
                <Button small variant="ghost" label="Edit" onPress={() => setEditing({ id: n.id, body: n.body })} />
                <Button small variant="ghost" label="Delete" onPress={() => remove(n)} />
              </View>
            </>
          )}
        </Card>
      )}
    />
  );
}

const st = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, minHeight: 64, textAlignVertical: "top" },
  quote: { borderLeftWidth: 3, paddingLeft: 8, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
