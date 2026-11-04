import { useIsFocused } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { api } from "../lib/api";
import type { VmAlert } from "../lib/types";
import { Card, Dot, ErrorBox, Screen, T } from "../ui/kit";
import { usePalette } from "../ui/theme";
import { NOT_AVAILABLE, useFetch } from "../ui/useFetch";

/** Health of the VM (the portal's System page): disk and memory, services, the shared browser, tools. */

const LABELS: Record<string, string> = {
  "agentbox-xvfb": "Display (Xvfb :99)",
  "agentbox-wm": "Window manager",
  "agentbox-vnc": "VNC server",
  "agentbox-novnc": "Web screen (noVNC)",
  "agentbox-ttyd": "Web terminal",
  "agentbox-chromium": "Shared browser",
};

const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

export function SystemScreen() {
  const p = usePalette();
  const focused = useIsFocused();
  const h = useFetch(() => api.health());

  // Refreshes every 15 s while in front.
  useEffect(() => {
    if (!focused) return;
    const t = setInterval(() => { h.refresh(); }, 15_000);
    return () => clearInterval(t);
  }, [focused, h.refresh]);

  if (h.missing) return <Screen style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></Screen>;
  const d = h.data;
  const alertOf = (id: string) => d?.resources?.alerts.find((a) => a.id === id);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={h.refreshing} onRefresh={h.pull} />}>
        {h.error && <ErrorBox text={`Health check failed: ${h.error}`} />}
        {!d ? <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} /> : (
          <>
            {d.resources?.alerts.map((a) => <Alert key={a.id} a={a} />)}
            {d.resources && (
              <Section title="Resources">
                {d.resources.disks.map((x) => {
                  const al = alertOf(`disk:${x.mount}`) ?? alertOf(`inodes:${x.mount}`);
                  return (
                    <Meter key={x.mount} name={`Disk ${x.mount}`} pct={x.used_pct} level={al?.level}
                      detail={`${size(x.free)} free of ${size(x.total)}${x.inodes_used_pct !== null && x.inodes_used_pct >= 50 ? ` · files ${Math.round(x.inodes_used_pct)}%` : ""}`} />
                  );
                })}
                {d.resources.memory && (
                  <Meter name="Memory" pct={d.resources.memory.used_pct} level={alertOf("memory")?.level ?? alertOf("swap")?.level}
                    detail={`${size(d.resources.memory.available)} available of ${size(d.resources.memory.total)}${d.resources.memory.swap_total ? ` · swap ${Math.round(100 - (d.resources.memory.swap_free / d.resources.memory.swap_total) * 100)}%` : ""}`} />
                )}
              </Section>
            )}
            <Section title="Services">
              {Object.entries(d.services).length === 0 && <T muted size={13}>No services to watch on this agentbox.</T>}
              {Object.entries(d.services).map(([k, v]) => (
                <Row key={k} color={v === "active" ? p.ok : p.bad} word={v === "active" ? "Running" : v} name={LABELS[k] ?? k} />
              ))}
            </Section>
            {!d.browser.disabled && (
              <Section title="Shared browser">
                <Row color={d.browser.ok ? p.ok : p.bad} word={d.browser.ok ? "Reachable" : "Down"} name={d.browser.version ?? "Chromium"} />
              </Section>
            )}
            <Section title="Tools">
              {Object.entries(d.tools).map(([k, v]) => {
                const it = d.tool_integrations?.[k];
                if (!v && it && !it.connected) return <Row key={k} color={p.muted} word="Not set up" name={`${k} · comes with an integration`} />;
                return <Row key={k} color={v ? p.ok : p.bad} word={v ? "Installed" : "Missing"} name={v ? `${k} · ${v}` : k} />;
              })}
            </Section>
            <T muted size={12}>Refreshes every 15 s while open.</T>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <T muted weight="600" size={13}>{title.toUpperCase()}</T>
      <Card style={{ gap: 10 }}>{children}</Card>
    </View>
  );
}

function Row({ color, word, name }: { color: string; word: string; name: string }) {
  return (
    <View style={st.row}>
      <Dot color={color} size={8} />
      <T size={13} weight="600" style={{ width: 84 }}>{word}</T>
      <T size={13} style={{ flex: 1 }} numberOfLines={2}>{name}</T>
    </View>
  );
}

function Meter({ name, pct, detail, level }: { name: string; pct: number; detail: string; level?: VmAlert["level"] }) {
  const p = usePalette();
  const color = level === "critical" ? p.bad : level === "warn" ? p.warn : p.accent;
  return (
    <View style={{ gap: 4 }}>
      <View style={st.row}>
        <T size={14} weight="600" style={{ flex: 1 }}>{name}</T>
        <T size={14} weight="600" style={{ color: level ? color : p.text }}>{Math.round(pct)}%</T>
      </View>
      <View style={[st.track, { backgroundColor: p.surface2 }]}>
        <View style={{ width: `${Math.max(2, Math.min(100, pct))}%`, height: "100%", borderRadius: 4, backgroundColor: color }} />
      </View>
      <T muted size={12}>{detail}</T>
    </View>
  );
}

function Alert({ a }: { a: VmAlert }) {
  const p = usePalette();
  const color = a.level === "critical" ? p.bad : p.warn;
  return (
    <View accessibilityRole="alert" style={[st.alert, { borderColor: color, backgroundColor: p.surface }]}>
      <T weight="600" style={{ color }}>{a.title}</T>
      <T size={13}>{a.detail}</T>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  alert: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
});
