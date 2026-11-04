import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, BackHandler, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Stack } from "../nav";
import { usePairing, useSession } from "../lib/session";
import { useStore } from "../lib/store";
import { serverName } from "../lib/vault";
import { T } from "./kit";
import { PulseDot } from "./Pulse";
import { usePalette } from "./theme";

/**
 * The side menu (the portal's sidebar): every section, with live hints (what needs you, what's
 * working). Opened from the burger at the top left. Drawn in an RN <Modal>, which keeps the
 * activity's screenshot protection.
 */

export type Section = keyof Pick<Stack,
  "Overview" | "Work" | "Groups" | "Team" | "Activity" | "Routines" | "Documents" | "SharedScreen" | "Hosted" | "System" | "Connections" | "Settings">;

/** The sections, in the portal's order. Top-level screens show the burger instead of a back arrow. */
export const SECTIONS: { name: Section; label: string; icon: string; group: "work" | "computer" | "app" }[] = [
  { name: "Overview", label: "Home", icon: "⌂", group: "work" },
  { name: "Work", label: "Work", icon: "▤", group: "work" },
  { name: "Groups", label: "Groups", icon: "#", group: "work" },
  { name: "Team", label: "Team", icon: "☺", group: "work" },
  { name: "Activity", label: "Activity", icon: "≋", group: "work" },
  { name: "Routines", label: "Routines", icon: "↻", group: "work" },
  { name: "Documents", label: "Documents", icon: "❏", group: "work" },
  { name: "SharedScreen", label: "Screen", icon: "▣", group: "computer" },
  { name: "Hosted", label: "Hosted services", icon: "◎", group: "computer" },
  { name: "System", label: "System", icon: "♥", group: "computer" },
  { name: "Connections", label: "Integrations & repos", icon: "⚯", group: "computer" },
  { name: "Settings", label: "Settings", icon: "⚙", group: "app" },
];
export const TOP_LEVEL = new Set<string>(SECTIONS.map((s) => s.name));

type Ctx = { open: () => void; close: () => void };
const DrawerCtx = createContext<Ctx | null>(null);

export function useDrawer() {
  const c = useContext(DrawerCtx);
  if (!c) throw new Error("useDrawer outside DrawerProvider");
  return c;
}

/** `go`: show a section (as the only screen above Home). `current`: the section in front. */
export function DrawerProvider({ children, go, current }: { children: ReactNode; go: (name: Section | "Servers") => void; current: string | null }) {
  const [visible, setVisible] = useState(false);
  const x = useRef(new Animated.Value(0)).current;
  const open = useCallback(() => {
    setVisible(true);
    Animated.timing(x, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [x]);
  const close = useCallback(() => {
    Animated.timing(x, { toValue: 0, duration: 160, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setVisible(false));
  }, [x]);
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => sub.remove();
  }, [visible, close]);
  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <DrawerCtx.Provider value={value}>
      {children}
      {visible && <Panel x={x} close={close} go={(n) => { close(); go(n); }} current={current} />}
    </DrawerCtx.Provider>
  );
}

function Panel({ x, close, go, current }: { x: Animated.Value; close: () => void; go: (n: Section | "Servers") => void; current: string | null }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const w = Math.min(320, Math.round(width * 0.82));
  const pairing = usePairing();
  const { servers, lock } = useSession();
  const s = useStore();
  const needs = (s.attention ?? []).filter((a) => !a.seen_at && a.kind !== "reply").length;
  const working = s.work.live.filter((r) => [r.root, ...r.members].some((m) => m.status === "working")).length;
  const runs = s.runs?.length ?? 0;

  const hint = (name: Section): ReactNode => {
    if (name === "Overview" && needs) return <Badge n={needs} color={p.bad} pulse />;
    if (name === "Work" && working) return <View style={st.hint}><PulseDot color={p.accent} size={7} pulse /><T size={12} muted>{working}</T></View>;
    if (name === "Routines" && runs) return <View style={st.hint}><PulseDot color={p.accent} size={7} pulse /><T size={12} muted>{runs}</T></View>;
    if (name === "SharedScreen" && s.display) return <T size={12} muted>{s.display.holder === "owner" ? "yours" : "in use"}</T>;
    return null;
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.45)", opacity: x }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close the menu" />
      </Animated.View>
      <Animated.View style={[st.panel, {
        width, backgroundColor: p.bg, borderColor: p.border, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8,
        transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-w, 0] }) }],
      }]}>
        <Pressable onPress={() => go("Servers")} accessibilityRole="button" accessibilityLabel={`agentbox ${serverName(pairing)}. Switch or add another`}
          style={({ pressed }) => [st.server, { borderColor: p.border, backgroundColor: p.surface, opacity: pressed ? 0.8 : 1 }]}>
          <PulseDot color={s.connected ? p.ok : p.warn} size={8} />
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={1}>{serverName(pairing)}</T>
            <T muted size={12}>{s.connected ? "Live" : "Connecting…"}{s.paused ? " · paused" : ""} · {servers.length > 1 ? "switch" : "add another"}</T>
          </View>
          <T muted>⇄</T>
        </Pressable>
        <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
          {(["work", "computer", "app"] as const).map((g) => (
            <View key={g} style={{ marginTop: g === "work" ? 0 : 10 }}>
              {g !== "work" && <T muted weight="600" size={12} style={st.groupLabel}>{g === "computer" ? "COMPUTER" : "APP"}</T>}
              {SECTIONS.filter((x) => x.group === g).map((x) => {
                const on = current === x.name;
                return (
                  <Pressable key={x.name} onPress={() => go(x.name)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={x.label}
                    style={({ pressed }) => [st.item, { backgroundColor: on ? p.surface2 : pressed ? p.surface : "transparent" }]}>
                    <Text style={[st.icon, { color: on ? p.accent : p.muted }]}>{x.icon}</Text>
                    <T weight={on ? "700" : "500"} style={{ flex: 1 }}>{x.label}</T>
                    {hint(x.name)}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
        <Pressable onPress={() => { close(); lock(); }} accessibilityRole="button" style={[st.item, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border }]}>
          <Text style={[st.icon, { color: p.muted }]}>🔒</Text>
          <T>Lock now</T>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

export function Badge({ n, color, pulse = false }: { n: number; color: string; pulse?: boolean }) {
  return (
    <View style={st.hint}>
      {pulse && <PulseDot color={color} size={7} pulse />}
      <View style={[st.badge, { backgroundColor: color }]}><Text style={st.badgeText}>{n > 99 ? "99+" : n}</Text></View>
    </View>
  );
}

/** The burger, for a top-level screen's header. */
export function Burger() {
  const { open } = useDrawer();
  const p = usePalette();
  const s = useStore();
  const needs = (s.attention ?? []).some((a) => !a.seen_at && a.kind !== "reply");
  return (
    <Pressable onPress={open} hitSlop={12} accessibilityRole="button" accessibilityLabel={needs ? "Menu. Something needs you" : "Menu"} style={st.burger}>
      <View style={{ gap: 4 }}>
        {[0, 1, 2].map((i) => <View key={i} style={{ width: 20, height: 2, borderRadius: 1, backgroundColor: p.text }} />)}
      </View>
      {needs && <View style={[st.burgerDot, { backgroundColor: p.bad, borderColor: p.surface }]} />}
    </Pressable>
  );
}

const st = StyleSheet.create({
  panel: { position: "absolute", top: 0, bottom: 0, left: 0, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10 },
  server: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 6 },
  groupLabel: { paddingHorizontal: 12, paddingVertical: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, minHeight: 46, borderRadius: 10 },
  icon: { width: 22, textAlign: "center", fontSize: 17 },
  hint: { flexDirection: "row", alignItems: "center", gap: 2 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  burger: { width: 40, height: 40, justifyContent: "center", paddingLeft: 2 },
  burgerDot: { position: "absolute", top: 7, left: 18, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
});
