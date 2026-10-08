import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { loadImage } from "../lib/api";
import { usePalette } from "./theme";

/** An image from the VM (a /work path), fetched with a signed GET. Tap to view full screen. */
export function SignedImage({ path, alt }: { path: string; alt: string }) {
  const p = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(4 / 3);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setUri(null);
    setFailed(false);
    loadImage(path).then((u) => { if (alive) setUri(u); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [path]);

  if (failed) {
    return <Text style={{ color: p.muted, fontStyle: "italic", marginVertical: 4 }}>[image: {alt || "couldn't load"}]</Text>;
  }
  if (!uri) {
    return (
      <View style={[st.box, { backgroundColor: p.surface2, aspectRatio: 4 / 3 }]}>
        <ActivityIndicator color={p.muted} />
      </View>
    );
  }
  return (
    <>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={alt ? `Image ${alt}, open full screen` : "Open image full screen"} onPress={() => setOpen(true)}>
        <Image source={{ uri }} resizeMode="contain" accessibilityIgnoresInvertColors
          onLoad={(e) => { const { width, height } = e.nativeEvent.source; if (width > 0 && height > 0) setRatio(width / height); }}
          style={[st.box, { aspectRatio: Math.max(0.5, Math.min(ratio, 3)), backgroundColor: p.surface2 }]} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={st.full} onPress={() => setOpen(false)} accessibilityLabel="Close image">
          <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", height: "100%" }} />
        </Pressable>
      </Modal>
    </>
  );
}

const st = StyleSheet.create({
  box: { width: "100%", maxWidth: 360, borderRadius: 8, marginVertical: 6, alignItems: "center", justifyContent: "center" },
  full: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", padding: 8 },
});
