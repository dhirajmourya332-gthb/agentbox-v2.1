import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { base64url } from "../crypto/encoding";
import { fingerprint, publicKeyOf, sameFingerprint } from "../crypto/sign";
import { claimPairing } from "../lib/api";
import { parsePairingQr, type PairingPayload } from "../lib/qr";
import { useSession } from "../lib/session";
import { availableKeyMode, NoScreenLockError, savePairing, saveKey, wipeAll, type Pairing } from "../lib/vault";
import { Button, Card, ErrorBox, Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";

/** Scan the portal's QR, make a key, claim the pairing. Approval happens on the Pending screen. */
export function PairScreen() {
  const p = usePalette();
  const { startPending } = useSession();
  const [name, setName] = useState("My phone");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [perm, requestPerm] = useCameraPermissions();
  const handled = useRef(false);
  /** A scanned, valid code waiting for the person to confirm the host. */
  const [confirm, setConfirm] = useState<{ payload: PairingPayload; trusted: boolean } | null>(null);

  const startScan = async () => {
    setError(null);
    if (!(await availableKeyMode())) { setError(new NoScreenLockError().message); return; }
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) { setError("agentbox needs the camera to scan the pairing code."); return; }
    }
    handled.current = false;
    setScanning(true);
  };

  const onScan = (r: BarcodeScanningResult) => {
    if (handled.current) return;
    handled.current = true;
    setScanning(false);
    const parsed = parsePairingQr(r.data);
    if (!parsed.ok) { setError(parsed.reason); return; }
    setConfirm({ payload: parsed.payload, trusted: parsed.trusted });
  };

  async function pair(qr: PairingPayload) {
    setBusy(true);
    setError(null);
    const deviceName = name.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 40) || "Phone";
    let privateKey: Uint8Array | null = null;
    try {
      const mode = await availableKeyMode();
      if (!mode) throw new NoScreenLockError();
      privateKey = getRandomBytes(32);
      const publicKey = publicKeyOf(privateKey);
      const fp = fingerprint(publicKey);
      await wipeAll();
      // Save the key first (this may ask for a fingerprint); if that's cancelled, the code is unused.
      await saveKey(privateKey, mode);
      const claim = await claimPairing(qr.gateway, {
        code: qr.code,
        public_key: base64url(publicKey),
        device_name: deviceName,
        app_version: Constants.expoConfig?.version ?? "1.0.0",
      });
      if (!sameFingerprint(claim.fingerprint, fp)) {
        throw new Error("agentbox reported a different key fingerprint than this phone made. Pairing stopped; deny the request in the portal.");
      }
      const pairing: Pairing = {
        v: 1, gateway: qr.gateway, deviceId: claim.deviceId, deviceName, fingerprint: fp, keyMode: mode, status: "pending", claimedAt: Date.now(),
      };
      await savePairing(pairing);
      startPending(pairing, privateKey);
      privateKey = null; // handed to the keyring, which zeroes our copy
    } catch (e) {
      await wipeAll();
      setError(e instanceof Error ? e.message : "Pairing failed.");
    } finally {
      privateKey?.fill(0);
      setBusy(false);
    }
  }

  if (confirm) {
    const { payload, trusted } = confirm;
    return (
      <Screen>
        <ScrollView contentContainerStyle={st.body}>
          <T size={24} weight="700">Connect to this agentbox?</T>
          <Card style={{ gap: 6, alignItems: "center", paddingVertical: 20 }}>
            <T muted size={13}>Gateway host</T>
            <T selectable size={20} weight="700" style={{ fontFamily: "monospace", textAlign: "center" }}>{payload.host}</T>
          </Card>
          <T>Make sure this matches the host shown in the portal.</T>
          {!trusted && (
            <ErrorBox text={`${payload.host} isn't a *.ts.net Tailscale address. Only continue if you set this address yourself on the portal's Devices page.`} />
          )}
          <Button variant={trusted ? "primary" : "danger"} label={trusted ? `Connect to ${payload.host}` : "I set this address, connect"}
            onPress={() => { setConfirm(null); pair(payload); }} />
          <Button variant="ghost" label="Cancel" onPress={() => setConfirm(null)} />
        </ScrollView>
      </Screen>
    );
  }

  if (scanning) {
    return (
      <Screen>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
        <View style={[st.scanBar, { backgroundColor: p.surface }]}>
          <T muted style={{ flex: 1 }}>Point at the QR code on the portal's Devices page.</T>
          <Button small label="Cancel" onPress={() => setScanning(false)} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
          <T size={28} weight="700">Pair with agentbox</T>
          <T muted>
            On your Mac, open the agentbox portal → Devices → Pair a phone. Then scan the code here. This phone needs Tailscale on,
            in the same tailnet.
          </T>
          <Card style={{ gap: 8 }}>
            <T weight="600">Name this phone</T>
            <TextInput value={name} onChangeText={setName} maxLength={40} autoCorrect={false}
              accessibilityLabel="Phone name"
              style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface2 }]} />
            <T muted size={13}>Shown in the portal so you can tell your devices apart.</T>
          </Card>
          {error && <ErrorBox text={error} />}
          <Button variant="primary" label={busy ? "Pairing…" : "Scan pairing code"} busy={busy} onPress={startScan} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  body: { padding: 24, gap: 18, flexGrow: 1, justifyContent: "center" },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  scanBar: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
});
