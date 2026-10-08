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
});
