import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSession } from "../lib/session";
import { serverName, type Pairing } from "../lib/vault";
import { showDialog } from "../ui/dialog";
import { Button, Card, Dot, Screen, T } from "../ui/kit";
import { relTime, usePalette } from "../ui/theme";

/**
 * Every agentbox this phone is paired with (e.g. one per VM on the tailnet). Switch between them,
 * name them, add another, or forget one. Each has its own key; switching locks the current one
 * and asks you to unlock the other.
 */
export function ServersScreen() {
  const p = usePalette();
  const { phase, servers, switchTo, rename, addServer, forgetOther } = useSession();
  const active = phase.name === "ready" || phase.name === "pending" ? phase.pairing.deviceId : null;
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const startEdit = (x: Pairing) => { setEditing(x.deviceId); setLabel(x.label ?? ""); };
  const save = async () => {
    if (editing) await rename(editing, label).catch(() => {});
    setEditing(null);
  };
  const confirmForget = (x: Pairing) =>
    showDialog(`Forget ${serverName(x)}?`, x.deviceId === active
      ? "Asks this agentbox to remove this phone, then deletes its key here. Your other agentboxes stay paired."
      : "Deletes this phone's key and pairing for it. It isn't unlocked, so it can't be told: revoke this phone on its portal's Devices page too.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => { forgetOther(x.deviceId); } },
    ]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        <T muted size={13}>
          Each agentbox (each VM) on your tailnet is paired separately and has its own key on this phone. Only the one you're using is unlocked.
        </T>
        {servers.map((x) => {
          const on = x.deviceId === active;
          return (
            <Card key={x.deviceId} style={[{ gap: 8 }, on && { borderColor: p.accent, borderWidth: 1 }]}>
              <Pressable onPress={on ? undefined : () => switchTo(x.deviceId)} disabled={on} accessibilityRole="button"
                accessibilityLabel={on ? `${serverName(x)}, in use` : `Switch to ${serverName(x)}`} style={st.row}>
                <Dot color={on ? p.accent : x.status === "active" ? p.ok : p.warn} size={10} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="600" numberOfLines={1}>{serverName(x)}{on ? "  · in use" : ""}</T>
                  <T muted size={12} numberOfLines={1} selectable>{x.gateway.replace("https://", "")}</T>
                  <T muted size={12}>
                    {x.status === "active" ? "Paired" : "Waiting for approval"} {relTime(new Date(x.claimedAt).toISOString())} · as {x.deviceName}
                  </T>
                </View>
              </Pressable>
              {editing === x.deviceId ? (
                <View style={st.row}>
                  <TextInput value={label} onChangeText={setLabel} maxLength={40} autoFocus placeholder="e.g. GCP Mumbai" placeholderTextColor={p.muted}
                    onSubmitEditing={save} accessibilityLabel="Name for this agentbox"
                    style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface2 }]} />
                  <Button small variant="primary" label="Save" onPress={save} />
                </View>
              ) : (
                <View style={st.row}>
                  {!on && <Button small variant="primary" label="Switch" onPress={() => switchTo(x.deviceId)} style={{ flex: 1 }} />}
                  <Button small label="Rename" onPress={() => startEdit(x)} style={{ flex: 1 }} />
                  <Button small variant="ghost" label="Forget" onPress={() => confirmForget(x)} style={{ flex: 1 }} />
                </View>
              )}
            </Card>
          );
        })}
        <Button variant="primary" label="+ Add another agentbox" onPress={addServer} />
        <T muted size={13}>
          To add one: open that agentbox's portal → Devices → Pair a phone, then scan its code. The phone must be on the same tailnet as that VM.
        </T>
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
});
