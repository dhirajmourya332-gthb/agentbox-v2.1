import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import type { Props } from "../nav";
import { loadText } from "../lib/api";
import { ErrorBox, Screen, T } from "../ui/kit";
import { docKind } from "../ui/Live";
import { Markdown } from "../ui/Markdown";
import { SignedImage } from "../ui/SignedImage";
import { usePalette } from "../ui/theme";

/**
 * Read-only document viewer: markdown rendered, plain text as is, images shown. Everything else
 * (PDF, HTML, Office files, SVG) says "Open on the Mac": the phone doesn't render them.
 */
export function DocScreen({ route, navigation }: Props<"Doc">) {
  const { path, name } = route.params;
  const p = usePalette();
  const kind = docKind(name);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => { navigation.setOptions({ title: name }); }, [navigation, name]);

  useEffect(() => {
    if (kind !== "markdown" && kind !== "text") return;
    let alive = true;
    loadText(path).then((t) => { if (alive) setText(t); }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Couldn't load the document"); });
    return () => { alive = false; };
  }, [path, kind]);

  const where = <T muted size={12} selectable>{path}</T>;

  if (kind === "other") {
    return (
      <Screen style={st.center}>
        <T size={17} weight="600">Open on the Mac</T>
        <T muted style={{ textAlign: "center" }}>The phone shows markdown, text and images. Open this one in the agentbox portal.</T>
        {where}
      </Screen>
    );
  }
  if (kind === "image") {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
          <SignedImage path={path} alt={name} />
          {where}
        </ScrollView>
      </Screen>
    );
  }
  if (error) return <Screen style={{ padding: 16, gap: 8 }}><ErrorBox text={error} />{where}</Screen>;
  if (text === null) return <Screen style={{ justifyContent: "center" }}><ActivityIndicator color={p.muted} /></Screen>;
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}>
        {kind === "markdown" ? <Markdown text={text} /> : (
          <ScrollView horizontal>
            <View><T selectable size={13} style={{ fontFamily: "monospace" }}>{text}</T></View>
          </ScrollView>
        )}
        <View style={[st.foot, { borderColor: p.border }]}>{where}</View>
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  center: { justifyContent: "center", alignItems: "center", padding: 24, gap: 10 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
});
