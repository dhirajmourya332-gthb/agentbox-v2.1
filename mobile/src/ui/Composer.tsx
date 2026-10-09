import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ActivityIndicator, Image, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Attachments } from "./Attachments";
import { T } from "./kit";
import { usePalette, type Palette } from "./theme";
import { clock, MicGlyph, type Voice } from "./Voice";

/**
 * The message box used by rooms, groups and New task: one rounded pill holding an auto-growing
 * text field, a "+" (attach) on the left and one primary button on the right that changes with
 * state: mic (empty) → send (text or images) → spinner (sending). While listening, the voice
 * controls replace the text field inside the same pill. Images show as thumbnails inside the pill.
 *
 * The parent owns the text, attachments, voice hook and the send itself, so screens keep their own
 * logic (e.g. the group's @mention picker, passed in as `above`).
 */

const LINE = 22;
const BTN = 44;

export function Composer({
  text, setText, att, voice, onSend, busy, error, placeholder, inputLabel, sendLabel, disabled, above, maxLines = 6,
}: {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  att: Attachments;
  voice: Voice;
  onSend: () => void;
  busy: boolean;
  error?: string | null;
  placeholder: string;
  inputLabel: string;
  sendLabel: string;
  /** Can't send for another reason (e.g. no agent picked yet). */
  disabled?: boolean;
  /** Rendered just above the pill (e.g. @mention suggestions). */
  above?: ReactNode;
  maxLines?: number;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  const [sheet, setSheet] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const hasContent = !!text.trim() || att.items.length > 0;
  const ready = (!!text.trim() || att.paths.length > 0) && !att.uploading && !busy && !voice.busy && !disabled;
  const listening = voice.phase === "starting" || voice.phase === "listening";
  const cleaning = voice.phase === "cleaning";

  const pick = () => {
    setSheet(false);
    setPickError(null);
    // Let the sheet close before the system picker opens over it.
    setTimeout(() => { att.pick().catch(() => setPickError("Couldn't open the photo picker")); }, 250);
  };

  let primary: ReactNode;
  if (busy) {
    primary = (
      <View style={[st.btn, { backgroundColor: p.accent }]} accessibilityLabel="Sending" accessibilityState={{ busy: true }}>
        <ActivityIndicator color={p.accentText} size="small" />
      </View>
    );
  } else if (hasContent) {
    primary = (
      <Pressable onPress={onSend} disabled={!ready} accessibilityRole="button" accessibilityLabel={sendLabel}
        accessibilityState={{ disabled: !ready }}
        style={({ pressed }) => [st.btn, { backgroundColor: p.accent, opacity: !ready ? 0.4 : pressed ? 0.8 : 1 }]}>
        <ArrowUp color={p.accentText} />
      </Pressable>
    );
  } else {
    primary = (
      <Pressable onPress={() => { voice.start().catch(() => {}); }} disabled={voice.busy} accessibilityRole="button"
        accessibilityLabel="Speak instead of typing" accessibilityState={{ disabled: voice.busy }}
        style={({ pressed }) => [st.btn, { backgroundColor: pressed ? p.surface2 : "transparent", opacity: voice.busy ? 0.4 : 1 }]}>
        <MicGlyph color={p.text} />
      </Pressable>
    );
  }

  const status = error ?? pickError;
  return (
    <View style={[st.wrap, { backgroundColor: p.bg, paddingBottom: 8 + (keyboard ? 0 : insets.bottom) }]}>
      {above}
      <View style={[st.pill, { backgroundColor: p.surface, borderColor: p.border }]}>
        {att.items.length > 0 && <Thumbs a={att} p={p} />}
        {listening ? (
          <View style={st.row} accessibilityLiveRegion="polite">
            <RoundButton label="Cancel and discard" onPress={voice.cancel} p={p}><Cross color={p.text} /></RoundButton>
            <View style={st.listen}>
              <View style={st.listenHead}>
                <Text style={{ color: p.bad, fontSize: 12 }}>●</Text>
                <T size={15} weight="600">{voice.phase === "starting" ? "Starting…" : `Listening ${clock(voice.seconds)}`}</T>
                {voice.engine && (
                  <View style={[st.tag, { borderColor: p.border }]}
                    accessibilityLabel={voice.engine === "online" ? "Speech goes to Google's online service" : "Speech stays on this phone"}>
                    <T muted size={11}>{voice.engine === "online" ? "Google" : "on-device"}</T>
                  </View>
                )}
              </View>
              {!!voice.live && (
                <Text style={{ color: p.muted, fontSize: 14, lineHeight: 19 }} numberOfLines={2} ellipsizeMode="head">{voice.live}</Text>
              )}
            </View>
            <Pressable onPress={voice.finish} disabled={voice.phase !== "listening"} accessibilityRole="button" accessibilityLabel="Done, use what I said"
              accessibilityState={{ disabled: voice.phase !== "listening" }}
              style={({ pressed }) => [st.btn, { backgroundColor: p.accent, opacity: voice.phase !== "listening" ? 0.4 : pressed ? 0.8 : 1 }]}>
              <Check color={p.accentText} />
            </Pressable>
          </View>
        ) : cleaning ? (
          <View style={st.row} accessibilityLiveRegion="polite">
            <View style={st.btn}><ActivityIndicator color={p.muted} size="small" /></View>
            <T size={15} muted style={{ flex: 1 }}>Cleaning up…</T>
            <RoundButton label="Cancel and discard" onPress={voice.cancel} p={p}><Cross color={p.text} /></RoundButton>
          </View>
        ) : (
          <View style={st.row}>
            <RoundButton label="Add images" onPress={() => setSheet(true)} p={p} disabled={busy}><Plus color={p.text} /></RoundButton>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder={placeholder}
              placeholderTextColor={p.muted}
              accessibilityLabel={inputLabel}
              textAlignVertical="center"
              style={[st.input, { color: p.text, maxHeight: LINE * maxLines + 22 }]}
            />
            {primary}
          </View>
        )}
      </View>
      {!!status && <Text style={[st.status, { color: p.bad }]} accessibilityRole="alert">{status}</Text>}
      <VoiceNote v={voice} p={p} />
      <AttachSheet visible={sheet} onClose={() => setSheet(false)} onPhoto={pick} full={att.items.length >= 10} p={p} />
    </View>
  );
}

/** Only what needs the user's attention: a voice error, or a cleanup that changed or failed. */
function VoiceNote({ v, p }: { v: Voice; p: Palette }) {
  if (v.busy) return null;
  if (v.error) {
    return (
      <Pressable onPress={v.dismiss} accessibilityRole="button" accessibilityLabel={`${v.error} Dismiss`} style={st.note}>
        <Text style={{ color: p.bad, fontSize: 13, flex: 1 }}>{v.error}</Text>
        <T muted size={13}>✕</T>
      </Pressable>
    );
  }
  if (v.result && (v.result.warn || v.result.swap)) {
    return (
      <View style={st.note}>
        <Text style={{ color: v.result.warn ? p.bad : p.muted, fontSize: 13, flex: 1 }}>{v.result.note}</Text>
        {v.result.swap && (
          <Pressable onPress={v.applyRaw} accessibilityRole="button" accessibilityLabel="Use the text as heard" hitSlop={10}>
            <T size={13} weight="600" style={{ color: p.accent }}>Use raw</T>
          </Pressable>
        )}
        <Pressable onPress={v.dismiss} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={10}>
          <T muted size={13}>✕</T>
        </Pressable>
      </View>
    );
  }
  return null;
}

function Thumbs({ a, p }: { a: Attachments; p: Palette }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      contentContainerStyle={st.thumbs} accessibilityLabel="Attached images">
      {a.items.map((i) => (
        <View key={i.id} style={[st.thumb, { borderColor: i.error ? p.bad : p.border, backgroundColor: p.surface2 }]}>
          <Image source={{ uri: i.preview }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          {!i.path && !i.error && <View style={st.overlay}><ActivityIndicator color="#fff" size="small" /></View>}
          {i.error && <View style={st.overlay}><Text style={st.errText} numberOfLines={3}>{i.error}</Text></View>}
          <Pressable onPress={() => a.remove(i.id)} accessibilityRole="button" accessibilityLabel={i.error ? `Remove image: ${i.error}` : "Remove image"}
            hitSlop={12} style={st.x}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 11 }}>✕</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/** The "+" menu. An in-app sheet (RN's Modal keeps FLAG_SECURE), not a system dialog. */
function AttachSheet({ visible, onClose, onPhoto, full, p }: {
  visible: boolean; onClose: () => void; onPhoto: () => void; full: boolean; p: Palette;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[st.sheet, { backgroundColor: p.surface, borderColor: p.border, paddingBottom: 12 + insets.bottom }]} onPress={() => {}}>
          <View style={[st.handle, { backgroundColor: p.border }]} />
          <Pressable onPress={onPhoto} disabled={full} accessibilityRole="button" accessibilityLabel="Photo from gallery"
            accessibilityState={{ disabled: full }}
            style={({ pressed }) => [st.item, { backgroundColor: pressed ? p.surface2 : "transparent", opacity: full ? 0.5 : 1 }]}>
            <View style={[st.itemIcon, { backgroundColor: p.surface2 }]}><PhotoGlyph color={p.text} /></View>
            <View style={{ flex: 1 }}>
              <T weight="600">Photo from gallery</T>
              <T muted size={13}>{full ? "10 images is the limit" : "PNG, JPEG, GIF or WebP, up to 10 MB each"}</T>
            </View>
          </Pressable>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel"
            style={({ pressed }) => [st.item, { justifyContent: "center", backgroundColor: pressed ? p.surface2 : "transparent" }]}>
            <T weight="600" muted>Cancel</T>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RoundButton({ label, onPress, p, disabled, children }: {
  label: string; onPress: () => void; p: Palette; disabled?: boolean; children: ReactNode;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [st.btn, { backgroundColor: pressed ? p.surface2 : "transparent", opacity: disabled ? 0.4 : 1 }]}>
      {children}
    </Pressable>
  );
}

function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener("keyboardDidShow", () => setShown(true));
    const b = Keyboard.addListener("keyboardDidHide", () => setShown(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return shown;
}

// --- Icons, drawn with views (the app has no icon font) ----------------------------------------

function Plus({ color }: { color: string }) {
  return (
    <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: 18, height: 2, borderRadius: 1, backgroundColor: color }} />
      <View style={{ position: "absolute", width: 2, height: 18, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

function Cross({ color }: { color: string }) {
  return (
    <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", transform: [{ rotate: "45deg" }] }}>
      <View style={{ position: "absolute", width: 18, height: 2, borderRadius: 1, backgroundColor: color }} />
      <View style={{ position: "absolute", width: 2, height: 18, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

function ArrowUp({ color }: { color: string }) {
  return (
    <View style={{ width: 18, height: 18, alignItems: "center" }}>
      <View style={{ width: 10, height: 10, borderLeftWidth: 2, borderTopWidth: 2, borderColor: color, transform: [{ rotate: "45deg" }], marginTop: 2 }} />
      <View style={{ position: "absolute", top: 2, width: 2, height: 15, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

function Check({ color }: { color: string }) {
  return (
    <View style={{ width: 7, height: 13, borderRightWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ rotate: "45deg" }], marginTop: -3 }} />
  );
}

function PhotoGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 20, height: 16, borderWidth: 1.5, borderColor: color, borderRadius: 3, overflow: "hidden" }}>
      <View style={{ position: "absolute", top: 2, right: 3, width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
      <View style={{ position: "absolute", bottom: -5, left: 1, width: 10, height: 10, backgroundColor: color, transform: [{ rotate: "45deg" }] }} />
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingTop: 6, gap: 4 },
  pill: { borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, padding: 4 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  btn: { width: BTN, height: BTN, borderRadius: BTN / 2, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, minHeight: BTN, fontSize: 16, lineHeight: LINE, paddingTop: 11, paddingBottom: 11, paddingHorizontal: 6 },
  listen: { flex: 1, minHeight: BTN, justifyContent: "center", paddingHorizontal: 6, paddingVertical: 4, gap: 1 },
  listenHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  tag: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  thumbs: { gap: 8, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 },
  thumb: { width: 56, height: 56, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 2 },
  errText: { color: "#fff", fontSize: 10, textAlign: "center" },
  x: { position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  status: { fontSize: 13, paddingHorizontal: 12 },
  note: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 2 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, gap: 2 },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: 8 },
  item: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 56, paddingHorizontal: 10, borderRadius: 12 },
  itemIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
