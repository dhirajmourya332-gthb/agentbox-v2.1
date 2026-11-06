import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  answerPending, assistantName, chooseTarget, disableHandsFree, enableHandsFree, handsFreeAvailable, setAssistantPrefs, talk,
  useAssistant, useAssistantPrefs, type Action, type Sensitivity,
} from "../lib/assistant";
import { useSession } from "../lib/session";
import { wakeNameProblem } from "../lib/wakeTokens";
import { Button, Card, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import { PulseDot } from "../ui/Pulse";
import { usePalette } from "../ui/theme";

/** What a proposal does, in words (also what the assistant read out before "Shall I?"). */
function describe(a: Action) {
  switch (a.kind) {
    case "new_task": return `New task for ${a.role_name}: ${a.title}`;
    case "reply": return `Message to ${a.agent_name}${a.work ? ` (${a.work})` : ""}: ${a.text}`;
    case "decide_plan": return `${a.verdict === "approve" ? "Approve" : a.verdict === "reject" ? "Reject" : "Send back"} ${a.agent_name}'s plan "${a.title}"${a.note ? `: ${a.note}` : ""}`;
    case "run_routine": return `Run ${a.routine_name} now`;
  }
}

export function AssistantScreen() {
  const p = usePalette();
  const a = useAssistant();
  const prefs = useAssistantPrefs();
  const { servers } = useSession();
  const [phrase, setPhrase] = useState(prefs.wakePhrase);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setPhrase(prefs.wakePhrase); }, [prefs.wakePhrase]);

  const name = assistantName(prefs.wakePhrase);
  const problem = phrase.trim() === prefs.wakePhrase ? null : wakeNameProblem(phrase);
  const can = handsFreeAvailable();
  const active = a.phase !== "idle";

  const toggleHandsFree = async () => {
    setMsg(null);
    if (a.handsFree) { disableHandsFree(); return; }
    setBusy(true);
    try { setMsg(await enableHandsFree(servers)); } finally { setBusy(false); }
  };
  const savePhrase = async () => {
    setMsg(null);
    try { await setAssistantPrefs({ wakePhrase: phrase.trim() }); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };

  const status = a.phase === "listening" ? (a.live || "Listening…") : a.phase === "thinking" ? "Thinking…" : a.phase === "speaking" ? "Speaking…"
    : a.phase === "acting" ? "Doing it…" : a.handsFree ? `Say "${prefs.wakePhrase}", or tap to talk.` : "Tap to talk.";
  const input = [st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", gap: 12, paddingVertical: 8 }}>
          <Pressable onPress={() => { void talk("button"); }} accessibilityRole="button" accessibilityLabel={active ? "Stop" : `Talk to ${name}`}
            style={({ pressed }) => [st.mic, { backgroundColor: active ? p.bad : p.accent, opacity: pressed ? 0.85 : 1 }]}>
            {active ? <PulseDot color={p.accentText} size={18} pulse /> : <MicGlyph color={p.accentText} />}
          </Pressable>
          <T size={17} weight="600" style={{ textAlign: "center" }}>{name}</T>
          <T muted style={{ textAlign: "center" }} numberOfLines={3}>{status}</T>
        </View>

        {a.targets.length > 1 ? (
          <Segmented value={a.target?.deviceId ?? ""} onChange={chooseTarget}
            options={a.targets.map((t) => ({ key: t.deviceId, label: t.name }))} />
        ) : a.target ? <T muted size={13} style={{ textAlign: "center" }}>Asking {a.target.name}</T> : (
          <T muted size={13} style={{ textAlign: "center" }}>No agentbox unlocked for the assistant.</T>
        )}

        {a.pending ? (
          <Card style={{ gap: 10 }}>
            <T weight="600">Waiting for your yes</T>
            <T>{describe(a.pending)}</T>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button label="Yes, do it" variant="primary" onPress={() => { void answerPending(true); }} style={{ flex: 1 }} />
              <Button label="No" onPress={() => { void answerPending(false); }} style={{ flex: 1 }} />
            </View>
          </Card>
        ) : null}

        {a.error ? <ErrorBox text={a.error} /> : null}

        {a.lines.length ? (
          <Card style={{ gap: 10 }}>
            {[...a.lines].reverse().slice(0, 16).map((l) => (
              <View key={`${l.at}-${l.who}`} style={{ gap: 2 }}>
                <T size={12} muted weight="600">{l.who === "you" ? "You" : name}</T>
                <T selectable>{l.text}</T>
              </View>
            ))}
          </Card>
        ) : (
          <Card style={{ gap: 6 }}>
            <T weight="600">Try</T>
            {["What's the update on the migration?", "What needs me?", "Tell the lead to go with option two.", "Start a task for the platform crew to add rate limits.",
              "Switch to the other agentbox.", "What needs me on all agentboxes?"].map((x) => <T key={x} muted>“{x}”</T>)}
          </Card>
        )}

        <Card style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T weight="600">Hands-free</T>
              <T muted size={13}>
                {a.handsFree
                  ? `On${a.wake === "listening" ? `: listening for "${prefs.wakePhrase}"` : a.wake === "paused" ? ": in a conversation" : ""}. Works with the screen off and the app locked.`
                  : can ? `Wake ${name} by saying "${prefs.wakePhrase}", even with the screen off.` : "Not available on this phone or app version."}
              </T>
            </View>
            <Button small label={a.handsFree ? "Turn off" : "Turn on"} variant={a.handsFree ? "default" : "primary"} busy={busy} disabled={!can && !a.handsFree}
              onPress={() => { void toggleHandsFree(); }} />
          </View>
          {msg ? <T size={13} style={{ color: p.warn }}>{msg}</T> : null}

          <T weight="600">Wake phrase</T>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput value={phrase} onChangeText={setPhrase} maxLength={40} autoCapitalize="words" autoCorrect={false}
              accessibilityLabel="Wake phrase" placeholder="Hey Nova" placeholderTextColor={p.muted} style={[input, { flex: 1 }]} />
            <Button small label="Save" disabled={phrase.trim() === prefs.wakePhrase || !!problem} onPress={() => { void savePhrase(); }} />
          </View>
          {problem ? <T size={13} style={{ color: p.warn }}>{problem}</T> : (
            <T muted size={13}>Two or three distinct words work best ("Hey Nova", "OK Jarvis"). It answers as "{assistantName(phrase)}".</T>
          )}

          <T weight="600">How easily it wakes</T>
          <Segmented<Sensitivity> value={prefs.sensitivity} onChange={(s) => { void setAssistantPrefs({ sensitivity: s }); }}
            options={[{ key: "low", label: "Rarely by mistake" }, { key: "normal", label: "Normal" }, { key: "high", label: "Easily" }]} />
        </Card>

        <T muted size={13}>
          The wake phrase is spotted on this phone; no audio leaves it. After the beep, what you say is turned into text by Android (on-device when the
          offline model is installed, see Settings, Voice) and only that text goes to your agentbox, where Claude answers. Anything that changes work
          (a new task, a reply, a plan decision, running a routine) is read back first and happens only when you say yes. Turning hands-free on unlocks
          each agentbox once; the keys stay in memory until you turn it off. Android shows a notification while it listens, and it uses some battery.
        </T>
      </ScrollView>
    </Screen>
  );
}

function MicGlyph({ color }: { color: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ width: 18, height: 30, borderRadius: 9, backgroundColor: color }} />
      <View style={{ width: 30, height: 15, borderBottomLeftRadius: 15, borderBottomRightRadius: 15, borderWidth: 3, borderTopWidth: 0, borderColor: color, marginTop: -9 }} />
      <View style={{ width: 3, height: 7, backgroundColor: color }} />
    </View>
  );
}

const st = StyleSheet.create({
  mic: { width: 112, height: 112, borderRadius: 56, alignItems: "center", justifyContent: "center", elevation: 3 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
});
