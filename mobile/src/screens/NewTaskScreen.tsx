import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { useAttachments } from "../ui/Attachments";
import { Composer } from "../ui/Composer";
import { Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";
import { useVoice } from "../ui/Voice";

/** Start a task: pick the role (and an optional title), then say what's needed in the composer. Each task gets its own room. */
export function NewTaskScreen({ navigation }: Props<"NewTask">) {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const { agents, loaded } = useStore();
  const roles = agents.filter((a) => !a.base_agent_id);
  const lead = roles.find((r) => r.can_scale);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments();

  useEffect(() => {
    if (!picked && loaded) setPicked(lead?.id ?? roles[0]?.id ?? null);
  }, [loaded, picked, lead, roles]);

  const role = roles.find((r) => r.id === picked);
  const voice = useVoice({ purpose: "task", agentId: role?.id, setText });
  const can = !!role && (!!text.trim() || att.paths.length > 0) && !att.uploading && !busy && !voice.busy;

  const start = async () => {
    if (!can || !role) return;
    setBusy(true);
    setError(null);
    try {
      const inst = await api.newTask(role.id, text.trim(), title.trim() || undefined, att.paths);
      att.clear();
      navigation.replace("Room", { id: inst.id, title: title.trim() || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the task");
      setBusy(false);
    }
  };

  const input = [st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }];
  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
        <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
          <T weight="600">Who should do it?</T>
          {loaded && !roles.length && <T muted>No agents yet. Create one in the portal.</T>}
          <View style={{ gap: 8 }} accessibilityRole="radiogroup">
            {roles.map((r) => {
              const on = r.id === picked;
              return (
                <Pressable key={r.id} onPress={() => setPicked(r.id)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                  style={[st.role, { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.surface2 : p.surface }]}>
                  <View style={[st.swatch, { backgroundColor: r.color || p.muted }]} />
                  <View style={{ flex: 1 }}>
                    <T weight="600">{r.name}</T>
                    <T muted size={13} numberOfLines={2}>{r.title}{r.can_scale ? " · plans and delegates" : ""}</T>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <T weight="600">Title <T muted size={13}>(optional)</T></T>
          <TextInput value={title} onChangeText={setTitle} maxLength={120} placeholder="Defaults to the first line" accessibilityLabel="Title"
            placeholderTextColor={p.muted} style={input} />
          <T muted size={13}>Say what needs doing below{role ? `; ${role.name} starts on it in a new room` : ""}.</T>
        </ScrollView>
        <Composer text={text} setText={setText} att={att} voice={voice} onSend={start} busy={busy} error={error} disabled={!role} maxLines={8}
          placeholder="What needs doing?"
          inputLabel="What needs doing" sendLabel={`Start${role ? ` with ${role.name}` : ""}`} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 24 },
  role: { flexDirection: "row", gap: 12, padding: 12, borderRadius: 10, borderWidth: 1.5 },
  swatch: { width: 4, borderRadius: 2 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
