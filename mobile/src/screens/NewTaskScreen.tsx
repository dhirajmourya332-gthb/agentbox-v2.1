import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Agent, Crew } from "../lib/types";
import { useAttachments } from "../ui/Attachments";
import { Composer } from "../ui/Composer";
import { Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";
import { useVoice } from "../ui/Voice";
import { TagInput } from "../ui/Tags";

/** The crew's lead: the one the crew names, else one that plans and delegates, else the first. */
export function crewLead(crewId: string, roles: Agent[], crews: Crew[]) {
  const chosen = crewId ? crews.find((c) => c.id === crewId)?.lead_role_id : null;
  return roles.find((r) => r.id === chosen) ?? roles.find((r) => r.can_scale) ?? roles[0];
}

/** The crew to open on next time (this session): the last one a task was started in. */
let lastCrew: string | null = null;

/**
 * Start a task (like the portal): pick the crew, then who in it does it (the crew's lead by
 * default), an optional title, then say what's needed in the composer. Each task gets its own room.
 */
export function NewTaskScreen({ navigation }: Props<"NewTask">) {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const { agents, crews, loaded } = useStore();
  // The helper starts from its own place on the portal, not here.
  const allRoles = useMemo(() => agents.filter((a) => !a.base_agent_id && !a.builtin && !a.retired_at), [agents]);
  // Crews: "" is the agents in no crew (offered only when there are some).
  const crewOf = (r: Agent) => (r.crew_id && crews.some((c) => c.id === r.crew_id) ? r.crew_id : "");
  const crewChoices = [...crews.map((c) => ({ id: c.id, name: c.name, summary: c.summary })),
    ...(allRoles.some((r) => !crewOf(r)) ? [{ id: "", name: "No crew", summary: "" }] : [])];
  const [crew, setCrew] = useState<string | null>(null);
  const roles = crews.length && crew !== null ? allRoles.filter((r) => crewOf(r) === crew) : allRoles;
  const lead = crews.length ? crewLead(crew ?? "", roles, crews) : allRoles.find((r) => r.can_scale);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments();

  // Open on the last crew used, else the first.
  useEffect(() => {
    if (!loaded || crew !== null) return;
    setCrew(lastCrew !== null && crewChoices.some((c) => c.id === lastCrew) ? lastCrew : crewChoices[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, crews.length]);
  // A new crew picks its lead; the person can still pick anyone in it.
  useEffect(() => {
    if (!loaded) return;
    if (!picked || !roles.some((r) => r.id === picked)) setPicked(lead?.id ?? roles[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, crew, roles.length]);
  const chooseCrew = (id: string) => {
    setCrew(id);
    setPicked(crewLead(id, allRoles.filter((r) => crewOf(r) === id), crews)?.id ?? null);
  };

  const role = roles.find((r) => r.id === picked);
  const voice = useVoice({ purpose: "task", agentId: role?.id, setText });
  const can = !!role && (!!text.trim() || att.paths.length > 0) && !att.uploading && !busy && !voice.busy;

  const start = async () => {
    if (!can || !role) return;
    setBusy(true);
    setError(null);
    try {
      const inst = await api.newTask(role.id, text.trim(), title.trim() || undefined, att.paths, tags);
      if (crews.length && crew !== null) lastCrew = crew;
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
          {crews.length > 0 && (
            <>
              <T weight="600">Which crew?</T>
              <View style={st.pills} accessibilityRole="radiogroup">
                {crewChoices.map((c) => {
                  const on = c.id === crew;
                  return (
                    <Pressable key={c.id || "none"} onPress={() => chooseCrew(c.id)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                      accessibilityLabel={`Crew ${c.name}`}
                      style={[st.pill, { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.surface2 : p.surface }]}>
                      <T size={14} weight={on ? "700" : "500"}>{c.name}</T>
                    </Pressable>
                  );
                })}
              </View>
              <T muted size={13}>Each crew is a separate team: its agents only hand work to each other.</T>
            </>
          )}
          <T weight="600">Who should do it?</T>
          {loaded && !allRoles.length && <T muted>No agents yet. Create one in the portal.</T>}
          {loaded && allRoles.length > 0 && !roles.length && <T muted>No agents in this crew yet. Move some in on the portal (Crews).</T>}
          <View style={{ gap: 8 }} accessibilityRole="radiogroup">
            {roles.map((r) => {
              const on = r.id === picked;
              return (
                <Pressable key={r.id} onPress={() => setPicked(r.id)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                  style={[st.role, { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.surface2 : p.surface }]}>
                  <View style={[st.swatch, { backgroundColor: r.color || p.muted }]} />
                  <View style={{ flex: 1 }}>
                    <T weight="600">{r.name}{lead?.id === r.id && roles.length > 1 ? <T muted size={13}>  · lead</T> : null}</T>
                    <T muted size={13} numberOfLines={2}>{r.title}{r.can_scale ? " · plans and delegates" : ""}</T>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {lead && lead.can_scale && picked !== lead.id && (
            <T muted size={13}>Anything with several steps or people? Give it to {lead.name}: it splits the work and hands it out.</T>
          )}
          <T weight="600">Title <T muted size={13}>(optional)</T></T>
          <TextInput value={title} onChangeText={setTitle} maxLength={120} placeholder="Defaults to the first line" accessibilityLabel="Title"
            placeholderTextColor={p.muted} style={input} />
          <T weight="600">Tags <T muted size={13}>(optional; filter Work by them, e.g. a client)</T></T>
          <TagInput value={tags} onChange={setTags} />
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
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { borderWidth: 1.5, borderRadius: 18, paddingHorizontal: 14, minHeight: 36, justifyContent: "center" },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
