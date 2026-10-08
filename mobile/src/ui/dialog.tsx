import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { usePalette } from "./theme";

/**
 * In-app replacement for Alert.alert. React Native's Alert is a separate Android dialog window
 * that does NOT inherit FLAG_SECURE, so its contents could be screenshotted. RN's <Modal> copies
 * FLAG_SECURE from the activity, so every dialog in the app goes through here instead.
 * Same call shape as Alert.alert.
 */

export type DialogButton = { text: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };
type Dialog = { id: number; title: string; message?: string; buttons: DialogButton[] };

let push: ((d: Dialog) => void) | null = null;
let seq = 0;

export function showDialog(title: string, message?: string, buttons?: DialogButton[]) {
  const d: Dialog = { id: seq++, title, message, buttons: buttons?.length ? buttons : [{ text: "OK" }] };
  push?.(d);
}

/** Mount once at the root (after screen protection is on). */
export function DialogHost() {
  const p = usePalette();
  const [queue, setQueue] = useState<Dialog[]>([]);
  useEffect(() => {
    push = (d) => setQueue((q) => [...q, d]);
    return () => { push = null; };
  }, []);

  const current = queue[0];
  const close = (b?: DialogButton) => {
    setQueue((q) => q.slice(1));
    b?.onPress?.();
  };
  if (!current) return null;
  const cancel = current.buttons.find((b) => b.style === "cancel");

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(cancel)} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={() => cancel && close(cancel)} accessibilityLabel="Dismiss">
        <Pressable style={[st.card, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityRole="alert" onPress={() => {}}>
          <Text style={[st.title, { color: p.text }]}>{current.title}</Text>
          {!!current.message && (
            <ScrollView style={{ maxHeight: 320 }}>
              <Text selectable style={{ color: p.muted, fontSize: 15, lineHeight: 21 }}>{current.message}</Text>
            </ScrollView>
          )}
          <View style={st.buttons}>
            {current.buttons.map((b, i) => (
              <Pressable key={i} onPress={() => close(b)} accessibilityRole="button" hitSlop={4}
                style={({ pressed }) => [st.btn, { opacity: pressed ? 0.6 : 1 }]}>
                <Text style={{ fontSize: 15, fontWeight: "600", color: b.style === "destructive" ? p.bad : b.style === "cancel" ? p.muted : p.accent }}>
                  {b.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  buttons: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btn: { paddingVertical: 10, paddingHorizontal: 12 },
});
