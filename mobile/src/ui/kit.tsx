import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { usePalette } from "./theme";

type Variant = "primary" | "default" | "danger" | "ghost";

export function Button({ label, onPress, variant = "default", disabled, busy, small, style, accessibilityLabel }: {
  label: string; onPress: () => void; variant?: Variant; disabled?: boolean; busy?: boolean; small?: boolean;
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const p = usePalette();
  const bg = variant === "primary" ? p.accent : variant === "danger" ? p.bad : variant === "ghost" ? "transparent" : p.surface2;
  const fg = variant === "primary" ? p.accentText : variant === "danger" ? "#fff" : variant === "ghost" ? p.accent : p.text;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn, small && s.small,
        { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.8 : 1, borderColor: variant === "default" ? p.border : bg },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} size="small" /> : <Text style={[s.btnText, small && s.smallText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function T({ children, style, muted, size, weight, selectable, numberOfLines, accessibilityLabel }: {
  children: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; size?: number; weight?: "400" | "500" | "600" | "700";
  selectable?: boolean; numberOfLines?: number; accessibilityLabel?: string;
}) {
  const p = usePalette();
  return (
    <Text selectable={selectable} numberOfLines={numberOfLines} accessibilityLabel={accessibilityLabel}
      style={[{ color: muted ? p.muted : p.text, fontSize: size ?? 15, fontWeight: weight ?? "400", lineHeight: (size ?? 15) * 1.4 }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[s.card, { backgroundColor: p.surface, borderColor: p.border }, style]}>{children}</View>;
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** A round initial in the agent's colour (the portal's Avatar). */
export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  const p = usePalette();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color || p.muted, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.45 }}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

/** A small rounded label, e.g. a status badge. */
export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[s.badge, { borderColor: color }]}>
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/** Two or more tabs as a segmented control. */
export function Segmented<K extends string>({ value, options, onChange }: { value: K; options: { key: K; label: string }[]; onChange: (k: K) => void }) {
  const p = usePalette();
  return (
    <View style={[s.seg, { backgroundColor: p.surface2 }]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[s.segBtn, on && { backgroundColor: p.surface }]}>
            <Text style={{ color: on ? p.text : p.muted, fontWeight: "600", fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ErrorBox({ text }: { text: string }) {
  const p = usePalette();
  return (
    <View accessibilityRole="alert" style={[s.err, { borderColor: p.bad }]}>
      <Text style={{ color: p.bad, fontSize: 14 }}>{text}</Text>
    </View>
  );
}

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[{ flex: 1, backgroundColor: p.bg }, style]}>{children}</View>;
}

const s = StyleSheet.create({
  btn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  small: { minHeight: 36, paddingHorizontal: 12 },
  btnText: { fontSize: 16, fontWeight: "600" },
  smallText: { fontSize: 14 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  err: { borderWidth: 1, borderRadius: 8, padding: 10 },
  badge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1 },
  seg: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 3 },
  segBtn: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: 8 },
});
