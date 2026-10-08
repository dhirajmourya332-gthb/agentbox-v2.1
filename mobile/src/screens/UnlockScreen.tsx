import { useCallback, useEffect, useRef, useState } from "react";
import { showDialog } from "../ui/dialog";
import { StyleSheet, View } from "react-native";
import { useSession } from "../lib/session";
import { KeyMissingError } from "../lib/vault";
import { Button, ErrorBox, Screen, T } from "../ui/kit";

/** Shown on every launch and after 2 minutes in the background. */
export function UnlockScreen() {
  const { phase, unlock, forget } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const tried = useRef(false);

  const go = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await unlock();
    } catch (e) {
      if (e instanceof KeyMissingError) setMissing(true);
      const msg = e instanceof Error ? e.message : "";
      setError(msg === "Cancelled" ? null : msg || "Couldn't unlock.");
    } finally {
      setBusy(false);
    }
  }, [unlock]);

  // Prompt straight away on first show.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    go();
  }, [go]);

  const pairing = phase.name === "locked" ? phase.pairing : null;
  const confirmForget = () =>
    showDialog("Forget this device?", "This deletes this phone's key and pairing. The app is locked, so it can't tell agentbox: revoke it on the portal's Devices page too.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => { forget(); } },
    ]);

  return (
    <Screen style={st.wrap}>
      <View style={st.center}>
        <T size={28} weight="700">agentbox</T>
        <T muted style={{ textAlign: "center" }}>
          {pairing?.keyMode === "biometric" ? "Unlock with your fingerprint or face." : "Unlock with your screen lock."}
        </T>
        {error && <ErrorBox text={error} />}
        {missing && (
          <T muted size={13} style={{ textAlign: "center" }}>
            If you changed your fingerprints or screen lock, Android deletes keys bound to them. Forget this device and pair again.
          </T>
        )}
        <Button variant="primary" label="Unlock" onPress={go} busy={busy} style={{ alignSelf: "stretch" }} />
      </View>
      <Button variant="ghost" label="Forget this device" onPress={confirmForget} />
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 24, justifyContent: "space-between" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 16 },
});
