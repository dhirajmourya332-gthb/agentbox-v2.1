import { useEffect, useState } from "react";
import { showDialog } from "../ui/dialog";
import { StyleSheet, View } from "react-native";
import { api, NotRecognizedError } from "../lib/api";
import { useSession } from "../lib/session";
import type { Pairing } from "../lib/vault";
import { Button, Card, Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";

const POLL_MS = 3000;

/** Show the fingerprint and wait for the owner to approve this phone in the portal. */
export function PendingScreen({ pairing }: { pairing: Pairing }) {
  const p = usePalette();
  const { markActive, forget } = useSession();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const who = await api.whoami();
        if (!alive) return;
        setOffline(false);
        if (who.status === "active") { await markActive(pairing); return; }
      } catch (e) {
        if (e instanceof NotRecognizedError) return; // denied or expired: the session shows re-pair
        if (alive) setOffline(true);
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [pairing, markActive]);

  const cancel = () =>
    showDialog("Cancel pairing?", "This phone forgets its key. Deny the request in the portal too.", [
      { text: "Keep waiting", style: "cancel" },
      { text: "Cancel pairing", style: "destructive", onPress: () => { forget(); } },
    ]);

  return (
    <Screen style={st.wrap}>
      <View style={st.center}>
        <T size={22} weight="700" style={{ textAlign: "center" }}>Approve this phone in the portal</T>
        <T muted style={{ textAlign: "center" }}>Check this matches the portal, then approve it there.</T>
        <Card style={st.fpCard}>
          <T muted size={13}>Fingerprint</T>
          <T selectable size={30} weight="700" style={st.fp} accessibilityLabel={`Fingerprint ${pairing.fingerprint.split("").join(" ")}`}>
            {`${pairing.fingerprint.slice(0, 9)}\n${pairing.fingerprint.slice(10)}`}
          </T>
          <T muted size={13}>{pairing.deviceName} · {pairing.gateway.replace("https://", "")}</T>
        </Card>
        <T muted size={13} style={{ textAlign: "center", color: offline ? p.warn : p.muted }}>
          {offline ? "Can't reach agentbox right now. Retrying…" : "Waiting for approval… (expires after 5 minutes)"}
        </T>
      </View>
      <Button variant="ghost" label="Cancel pairing" onPress={cancel} />
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 24 },
  center: { flex: 1, justifyContent: "center", gap: 16 },
  fpCard: { alignItems: "center", gap: 10, paddingVertical: 24 },
  fp: { fontFamily: "monospace", letterSpacing: 4, textAlign: "center", lineHeight: 44 },
});
