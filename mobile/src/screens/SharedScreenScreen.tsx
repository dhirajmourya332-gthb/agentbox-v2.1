import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, AppState, Image, KeyboardAvoidingView, PixelRatio, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { api, loadScreen } from "../lib/api";
import { isMissingRoute, useStore } from "../lib/store";
import { showDialog } from "../ui/dialog";
import { Button, Dot, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import { relTime, usePalette } from "../ui/theme";
import { NOT_AVAILABLE } from "../ui/useFetch";

/**
 * The shared screen (the portal's Screen page): the VM's display as frames, refreshed while this
 * screen is open. Holding control (Take control, like the portal), a tap clicks there, a long
 * press right-clicks, and the bar below scrolls, types and presses keys. Frames are fetched signed
 * and kept only in memory; screenshots of the app stay blocked.
 */

type Zoom = "1" | "2" | "3";
const KEYS: { key: string; label: string }[] = [
  { key: "Return", label: "Enter" }, { key: "BackSpace", label: "⌫" }, { key: "Tab", label: "Tab" }, { key: "Escape", label: "Esc" },
  { key: "Left", label: "←" }, { key: "Up", label: "↑" }, { key: "Down", label: "↓" }, { key: "Right", label: "→" },
  { key: "Page_Up", label: "PgUp" }, { key: "Page_Down", label: "PgDn" }, { key: "ctrl+l", label: "Ctrl+L" }, { key: "ctrl+a", label: "Ctrl+A" },
  { key: "ctrl+c", label: "Ctrl+C" }, { key: "ctrl+v", label: "Ctrl+V" }, { key: "ctrl+t", label: "Ctrl+T" }, { key: "F5", label: "Reload" },
];

export function SharedScreenScreen() {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const focused = useIsFocused();
  const { width: winW } = useWindowDimensions();
  const { display, nameOf } = useStore();
  const mine = display?.holder === "owner";
  const [zoom, setZoom] = useState<Zoom>("1");
  // Two stacked layers: a new frame decodes in the hidden one and only then comes to the front,
  // so the picture never blanks between frames (swapping one <Image>'s source flickers on Android).
  const [layers, setLayers] = useState<[string | null, string | null]>([null, null]);
  const [front, setFront] = useState<0 | 1>(0);
  const frontRef = useRef<0 | 1>(0);
  frontRef.current = front;
  const latest = useRef<string | null>(null);
  const frame = layers[front];
  const [mark, setMark] = useState<{ x: number; y: number; n: number } | null>(null);
  const markFade = useRef(new Animated.Value(0)).current;
  const [ratio, setRatio] = useState(1080 / 1920);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const last = useRef({ x: 0.5, y: 0.5 });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);

  const imgW = Math.round(winW * Number(zoom));
  const imgH = Math.round(imgW * ratio);

  // Frames only while this screen is in front and the app is open; faster while you're driving.
  useEffect(() => {
    if (!focused || !active || missing) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      clearTimeout(timer);
      try {
        // Fit needs no more than ~1280 px; zoomed in, sharper frames.
        const uri = await loadScreen(Math.min(zoom === "1" ? 1280 : 1920, PixelRatio.getPixelSizeForLayoutSize(imgW)));
        if (alive) {
          setError(null);
          // Nothing changed on the screen: keep the picture as it is (no re-render, no decode).
          if (uri !== latest.current) {
            latest.current = uri;
            setLayers((l) => {
              const f = frontRef.current, back = f === 0 ? 1 : 0;
              const next: [string | null, string | null] = [...l] as [string | null, string | null];
              if (!l[f]) next[f] = uri; // the first frame goes straight to the front
              else next[back] = uri;
              return next;
            });
          }
        }
      } catch (e) {
        if (!alive) return;
        if (isMissingRoute(e)) { setMissing(true); return; }
        setError(e instanceof Error ? e.message : "Couldn't load the screen");
      } finally {
        running = false;
      }
      if (alive) timer = setTimeout(tick, mine ? 400 : 1200);
    };
    kick.current = () => { setTimeout(tick, 150); };
    tick();
    return () => { alive = false; clearTimeout(timer); kick.current = () => {}; };
  }, [focused, active, missing, imgW, mine, zoom]);

  const send = useCallback(async (input: Parameters<typeof api.screenInput>[0]) => {
    try {
      await api.screenInput(input);
      kick.current();
    } catch (e) {
      showDialog("Couldn't do that", e instanceof Error ? e.message : "");
    }
  }, []);

  const onTap = (x: number, y: number, button: "left" | "right") => {
    if (!mine) return;
    const fx = Math.max(0, Math.min(1, x / imgW)), fy = Math.max(0, Math.min(1, y / imgH));
    last.current = { x: fx, y: fy };
    // Show where the tap landed straight away; the next frame shows its effect.
    setMark({ x, y, n: Date.now() });
    markFade.setValue(1);
    Animated.timing(markFade, { toValue: 0, duration: 700, useNativeDriver: true }).start();
    send({ kind: "tap", x: fx, y: fy, button });
  };

  const take = () => {
    const go = async () => {
      setBusy(true);
      try { await api.takeScreen(); kick.current(); } catch (e) { showDialog("Couldn't take control", e instanceof Error ? e.message : ""); }
      setBusy(false);
    };
    if (display && display.holder !== "owner") {
      const who = nameOf(display.holder) ?? "An agent";
      showDialog("Take the screen?", `${who} is using it${display.reason ? ` (${display.reason})` : ""}. Taking it interrupts that; agents are refused the screen until you give it back.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Take control", onPress: () => { go(); } },
      ]);
    } else go();
  };
  const release = async () => {
    setBusy(true);
    try { await api.releaseScreen(); } catch (e) { showDialog("Couldn't give it back", e instanceof Error ? e.message : ""); }
    setBusy(false);
  };

  const typeText = async () => {
    const v = text;
    if (!v) return;
    setText("");
    await send({ kind: "text", text: v });
  };

  if (missing) return <Screen style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></Screen>;

  const holder = !display ? "Nobody is using the screen" : mine ? "You have control" : `${nameOf(display.holder) ?? "An agent"} is using it`;
  const image = frame ? (
    <Pressable onPress={(e) => onTap(e.nativeEvent.locationX, e.nativeEvent.locationY, "left")}
      onLongPress={(e) => onTap(e.nativeEvent.locationX, e.nativeEvent.locationY, "right")} delayLongPress={450}
      disabled={!mine} accessibilityLabel={mine ? "Shared screen. Tap to click, long-press to right-click." : "Shared screen"}>
      <View style={{ width: imgW, height: imgH, backgroundColor: "#000" }}>
        {([0, 1] as const).map((i) => layers[i] ? (
          <Image key={i} source={{ uri: layers[i]! }} resizeMode="contain" fadeDuration={0}
            style={[StyleSheet.absoluteFill, { opacity: i === front ? 1 : 0 }]}
            onLoad={(e) => {
              const { width, height } = e.nativeEvent.source;
              if (width > 0 && height > 0 && Math.abs(height / width - ratio) > 0.001) setRatio(height / width);
              // The hidden layer finished decoding the newest frame: bring it to the front.
              if (i !== front && layers[i] === latest.current) setFront(i);
            }} />
        ) : null)}
        {mark && (
          <Animated.View pointerEvents="none" style={[st.mark, { left: mark.x - 14, top: mark.y - 14, borderColor: p.accent, opacity: markFade }]} />
        )}
      </View>
    </Pressable>
  ) : (
    <View style={{ width: winW, height: Math.round(winW * ratio), alignItems: "center", justifyContent: "center", backgroundColor: p.surface2 }}>
      <T muted>{error ? "" : "Loading the screen…"}</T>
    </View>
  );

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
        <View style={[st.bar, { borderColor: p.border }]}>
          <Dot color={mine ? p.accent : display ? p.warn : p.muted} size={8} />
          <View style={{ flex: 1 }}>
            <T size={14} weight="600" numberOfLines={1}>{holder}</T>
            {display && !mine && <T muted size={12} numberOfLines={1}>{display.reason || "working"} · since {relTime(display.since)}</T>}
          </View>
          {mine
            ? <Button small label="Give back" onPress={release} busy={busy} />
            : <Button small variant="primary" label="Take control" onPress={take} busy={busy} />}
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
          {Number(zoom) > 1 ? <ScrollView horizontal>{image}</ScrollView> : image}
          <View style={{ padding: 12, gap: 10 }}>
            {error && <ErrorBox text={error} />}
            <Segmented value={zoom} onChange={setZoom} options={[{ key: "1", label: "Fit" }, { key: "2", label: "2×" }, { key: "3", label: "3×" }]} />
            {mine ? (
              <>
                <T muted size={12}>Tap to click · long-press to right-click · scroll scrolls where you last tapped.</T>
                <View style={st.row}>
                  <Button small label="Scroll ↑" onPress={() => send({ kind: "scroll", ...last.current, dir: "up", amount: 4 })} style={{ flex: 1 }} />
                  <Button small label="Scroll ↓" onPress={() => send({ kind: "scroll", ...last.current, dir: "down", amount: 4 })} style={{ flex: 1 }} />
                </View>
                <View style={st.row}>
                  <TextInput value={text} onChangeText={setText} placeholder="Type into the screen…" placeholderTextColor={p.muted}
                    autoCapitalize="none" autoCorrect={false} onSubmitEditing={typeText} returnKeyType="send" accessibilityLabel="Text to type into the shared screen"
                    style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]} />
                  <Button small variant="primary" label="Type" onPress={typeText} disabled={!text} />
                </View>
                <View style={st.keys}>
                  {KEYS.map((k) => (
                    <Pressable key={k.key} onPress={() => send({ kind: "key", key: k.key })} accessibilityRole="button" accessibilityLabel={`Press ${k.label}`}
                      style={({ pressed }) => [st.key, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.7 : 1 }]}>
                      <T size={13} weight="600">{k.label}</T>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : (
              <T muted size={13}>Watching. Take control to click and type; agents are refused the screen until you give it back.</T>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  mark: { position: "absolute", width: 28, height: 28, borderRadius: 14, borderWidth: 3 },
  key: { minWidth: 52, minHeight: 36, paddingHorizontal: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
});
