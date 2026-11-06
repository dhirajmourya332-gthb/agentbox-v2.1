import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Stack } from "../nav";
import { clearAssistantPrefs, setAppTarget, startAssistantEvents, stopTalking, talk, targetsChanged, useAssistant } from "../lib/assistant";
import { syncLinks } from "../lib/assistantLink";
import * as keyring from "../lib/keyring";
import { useSession } from "../lib/session";
import { serverName } from "../lib/vault";
import { T } from "./kit";
import { PulseDot } from "./Pulse";
import { usePalette } from "./theme";

/**
 * Keeps the voice assistant (lib/assistant.ts) in step with the app: the native listener's
 * events, which agentbox is open, forgotten agentboxes. Mounted once, above the lock screen, so
 * hands-free carries on while the app is locked. While a conversation runs and the app is
 * unlocked, a strip at the bottom shows what's heard; tap it to stop.
 */
export function AssistantHost() {
  const { phase, servers } = useSession();
  const a = useAssistant();
  const p = usePalette();
  const insets = useSafeAreaInsets();

  useEffect(() => startAssistantEvents(), []);
  useEffect(() => keyring.onWipe(() => targetsChanged()), []);
  useEffect(() => {
    syncLinks(servers);
    if (!servers.length) void clearAssistantPrefs();
    targetsChanged();
  }, [servers]);

  const open = phase.name === "ready" ? phase.pairing : null;
  const openId = open?.deviceId ?? null;
  const openName = open ? serverName(open) : null;
  useEffect(() => {
    setAppTarget(openId && openName ? { deviceId: openId, name: openName } : null);
  }, [openId, openName]);

  if (phase.name !== "ready" || a.phase === "idle") return null;
  const label = a.phase === "listening" ? (a.live || "Listening…") : a.phase === "thinking" ? "Thinking…" : a.phase === "acting" ? "Doing it…" : "Speaking…";
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}>
      <Pressable onPress={stopTalking} accessibilityRole="button" accessibilityLabel="Stop the assistant"
        style={[s.bar, { backgroundColor: p.surface, borderColor: p.border, marginBottom: insets.bottom + 12 }]}>
        <PulseDot color={a.phase === "listening" ? p.bad : p.accent} pulse />
        <View style={{ flex: 1 }}>
          <T numberOfLines={2}>{label}</T>
          {a.target ? <T size={12} muted>{a.target.name} · tap to stop</T> : null}
        </View>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    marginHorizontal: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12,
    flexDirection: "row", alignItems: "center", gap: 10, elevation: 6,
  },
  headerBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", marginRight: 8 },
});

/** Header button on Home: tap to talk, hold to open the Assistant page. */
export function AssistantButton() {
  const p = usePalette();
  const nav = useNavigation<NativeStackNavigationProp<Stack>>();
  const a = useAssistant();
  const active = a.phase !== "idle";
  return (
    <Pressable onPress={() => { void talk("button"); }} onLongPress={() => nav.navigate("Assistant")} hitSlop={8}
      accessibilityRole="button" accessibilityLabel={active ? "Stop the assistant" : "Talk to the assistant"} accessibilityHint="Hold to open the assistant page"
      style={({ pressed }) => [s.headerBtn, { borderColor: p.border, backgroundColor: active ? p.bad : p.surface2, opacity: pressed ? 0.8 : 1 }]}>
      {active ? <PulseDot color={p.accentText} size={8} pulse /> : (
        <View style={{ alignItems: "center" }}>
          <View style={{ width: 7, height: 11, borderRadius: 4, backgroundColor: p.text }} />
          <View style={{ width: 12, height: 6, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, borderWidth: 1.5, borderTopWidth: 0, borderColor: p.text, marginTop: -3 }} />
        </View>
      )}
    </Pressable>
  );
}
