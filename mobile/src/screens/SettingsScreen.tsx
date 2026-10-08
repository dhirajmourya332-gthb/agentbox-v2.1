import Constants from "expo-constants";
import { useCallback, useEffect, useState } from "react";
import { showDialog } from "../ui/dialog";
import { AppState, Linking, ScrollView, StyleSheet, Switch, View } from "react-native";
import { downloadModel, LANGS, langLabel, onDeviceStatus, recognitionAvailable, setVoicePrefs, useVoicePrefs, type OnDeviceStatus } from "../lib/speech";
import { permissionState, requestPermission, syncPushToken } from "../lib/push";
import { usePairing, useSession, LOCK_AFTER_MS } from "../lib/session";
import { Button, Card, Screen, Segmented, T } from "../ui/kit";
import { usePalette } from "../ui/theme";

export function SettingsScreen() {
  const p = usePalette();
  const pairing = usePairing();
  const { lock, forget } = useSession();
  const [notif, setNotif] = useState<"granted" | "ask" | "denied" | null>(null);

  const check = useCallback(() => { permissionState().then(setNotif, () => setNotif(null)); }, []);
  useEffect(() => {
    check();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") { check(); syncPushToken(); } });
    return () => sub.remove();
  }, [check]);

  const enableNotifications = async () => {
    if (notif === "denied") {
      Linking.openSettings().catch(() => {});
      return;
    }
    const ok = await requestPermission().catch(() => false);
    check();
    if (ok) syncPushToken();
  };

  const confirmForget = () =>
    showDialog(
      "Forget this device?",
      "Asks agentbox to remove this phone, then deletes its key and pairing here. To pair again you'll need a new code from the portal. If agentbox can't be reached, revoke this phone on the portal's Devices page.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Forget", style: "destructive", onPress: () => { forget(); } },
      ],
    );

  const rows: [string, string][] = [
    ["Device name", pairing.deviceName],
    ["Fingerprint", pairing.fingerprint],
    ["Gateway", pairing.gateway],
    ["Device id", pairing.deviceId],
    ["Key protection", pairing.keyMode === "biometric" ? "Android Keystore, released only after strong biometrics" : "Android Keystore; screen-lock check enforced by the app (no strong biometrics on this phone)"],
    ["Auto-lock", `After ${LOCK_AFTER_MS / 60000} minutes in the background`],
    ["App version", Constants.expoConfig?.version ?? "?"],
  ];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Card style={{ gap: 12 }}>
          {rows.map(([k, v]) => (
            <View key={k} style={[st.row, { borderColor: p.border }]}>
              <T muted size={13}>{k}</T>
              <T selectable style={k === "Fingerprint" ? st.mono : undefined}>{v}</T>
            </View>
          ))}
        </Card>
        <Card style={{ gap: 8 }}>
          <T muted size={13}>Notifications</T>
          <T>{notif === "granted" ? "On" : notif === null ? "…" : "Off"}</T>
          <T muted size={13}>
            When an agent replies to you, fails or looks stuck. Notifications only say "Something needs you"; opening one still asks you to unlock.
          </T>
          {notif !== "granted" && notif !== null && (
            <Button small label={notif === "denied" ? "Open Android settings" : "Turn on notifications"} onPress={enableNotifications} style={{ alignSelf: "flex-start" }} />
          )}
        </Card>
        <VoiceCard />
        <Button label="Lock now" onPress={lock} />
        <Button variant="danger" label="Forget this device" onPress={confirmForget} />
        <T muted size={13}>Screenshots and screen recording are blocked in this app.</T>
      </ScrollView>
    </Screen>
  );
}

/** Voice settings: language, and whether speech may leave the phone. */
function VoiceCard() {
  const p = usePalette();
  const prefs = useVoicePrefs();
  const [status, setStatus] = useState<OnDeviceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const available = recognitionAvailable();

  const check = useCallback(() => {
    setStatus(null);
    onDeviceStatus(prefs.lang).then(setStatus, () => setStatus("unknown"));
  }, [prefs.lang]);
  useEffect(() => {
    check();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") check(); });
    return () => sub.remove();
  }, [check]);

  const download = async () => {
    setBusy(true);
    const msg = await downloadModel(prefs.lang).catch(() => "Couldn't start the download.");
    setBusy(false);
    showDialog("Offline model", msg);
    check();
  };

  const where = status === "installed"
    ? `On-device: the ${langLabel(prefs.lang)} model is installed, so your speech stays on this phone.`
    : status === "unsupported"
      ? "This phone can't recognise speech on-device (needs Android 13 or later with on-device recognition)."
      : status === "missing"
        ? `The on-device model for ${langLabel(prefs.lang)} isn't installed.`
        : status === "unknown" ? "Couldn't check for an on-device model." : "Checking…";
  const fallback = prefs.onDeviceOnly
    ? "On-device only is on: if the model isn't there, voice won't start."
    : "Without the on-device model, speech goes to Google's online recognition. The listening bar shows which one is in use.";

  return (
    <Card style={{ gap: 10 }}>
      <T muted size={13}>Voice</T>
      {!available && (
        <T size={13} style={{ color: p.bad }}>No speech recognition service found. Install or enable Google's speech services (or the Google app).</T>
      )}
      <Segmented value={prefs.lang} options={LANGS.map((l) => ({ key: l.key, label: l.short }))}
        onChange={(lang) => { setVoicePrefs({ lang }).catch(() => {}); }} />
      <View style={st.switchRow}>
        <T style={{ flex: 1 }}>On-device only</T>
        <Switch value={prefs.onDeviceOnly} onValueChange={(v) => { setVoicePrefs({ onDeviceOnly: v }).catch(() => {}); }}
          accessibilityLabel="Voice: on-device only" trackColor={{ true: p.accent, false: p.border }} />
      </View>
      <T muted size={13}>{where} {fallback}</T>
      {(status === "missing" || status === "unknown") && (
        <Button small label="Download offline model" busy={busy} disabled={busy} onPress={download} style={{ alignSelf: "flex-start" }} />
      )}
      <T muted size={13}>Only the recognised text is sent to agentbox to tidy up. It goes in the box for you to check; nothing is sent until you tap Send.</T>
    </Card>
  );
}

const st = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  row: { gap: 2 },
  mono: { fontFamily: "monospace", fontSize: 17, letterSpacing: 1 },
});
