import Constants from "expo-constants";
import { showDialog } from "../ui/dialog";
import { ScrollView, StyleSheet, View } from "react-native";
import { usePairing, useSession, LOCK_AFTER_MS } from "../lib/session";
import { Button, Card, Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";

export function SettingsScreen() {
  const p = usePalette();
  const pairing = usePairing();
  const { lock, forget } = useSession();

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
        <Button label="Lock now" onPress={lock} />
        <Button variant="danger" label="Forget this device" onPress={confirmForget} />
        <T muted size={13}>Screenshots and screen recording are blocked in this app.</T>
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { gap: 2 },
  mono: { fontFamily: "monospace", fontSize: 17, letterSpacing: 1 },
});
