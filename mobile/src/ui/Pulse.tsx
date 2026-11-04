import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";

/**
 * A status dot. `pulse`: a soft ring breathes around it (work in progress, or something waiting
 * for you), so it's visible at a glance without reading anything.
 */
export function PulseDot({ color, size = 10, pulse = false }: { color: string; size?: number; pulse?: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) { t.stopAnimation(); t.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [pulse, t]);
  const ring = size * 2.2;
  return (
    <View style={{ width: ring, height: ring, alignItems: "center", justifyContent: "center" }}>
      {pulse && (
        <Animated.View style={{
          position: "absolute", width: ring, height: ring, borderRadius: ring / 2, backgroundColor: color,
          opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }],
        }} />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}
