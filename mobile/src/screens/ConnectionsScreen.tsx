import { useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Badge, Card, ErrorBox, Screen, Segmented, T } from "../ui/kit";
import { relTime, usePalette, type Palette } from "../ui/theme";
import { NOT_AVAILABLE, useFetch } from "../ui/useFetch";

/**
 * Integrations, repos and skills at a glance (status only). Connecting, adding and editing stay on
 * the portal: they need sign-ins and secrets, which never go through the phone.
 */
export function ConnectionsScreen() {
  const [tab, setTab] = useState<"integrations" | "repos" | "skills">("integrations");
  return (
    <Screen>
      <View style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 }}>
        <Segmented value={tab} onChange={setTab} options={[{ key: "integrations", label: "Integrations" }, { key: "repos", label: "Repos" }, { key: "skills", label: "Skills" }]} />
      </View>
      {tab === "integrations" ? <Integrations /> : tab === "repos" ? <Repos /> : <Skills />}
    </Screen>
  );
}

const stateColor = (p: Palette, s: string) =>
  ["connected", "ready", "ok"].includes(s) ? p.ok : ["error", "failed", "broken"].includes(s) ? p.bad : ["connecting", "cloning", "running", "pending", "partial"].includes(s) ? p.warn : p.muted;

function Loading<T>({ f, children }: { f: ReturnType<typeof useFetch<T>>; children: (d: T) => React.ReactElement }) {
  const p = usePalette();
  if (f.missing) return <View style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></View>;
  if (!f.data) return <View style={{ padding: 16 }}>{f.error ? <ErrorBox text={f.error} /> : <ActivityIndicator style={{ marginTop: 32 }} color={p.muted} />}</View>;
  return children(f.data);
}

const FOOT = "Connect, add or change these on the portal: sign-ins and secrets never go through the phone.";

function Integrations() {
  const p = usePalette();
  const f = useFetch(() => api.integrations());
  return (
    <Loading f={f}>{(d) => (
      <FlatList data={[...d.integrations].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.title.localeCompare(b.title))} keyExtractor={(x) => x.id}
        contentContainerStyle={st.list} refreshing={f.refreshing} onRefresh={f.pull}
        ListHeaderComponent={d.error ? <ErrorBox text={d.error} /> : null}
        ListFooterComponent={<T muted size={12}>{FOOT}</T>}
        renderItem={({ item: x }) => (
          <Card style={st.card}>
            <View style={st.row}>
              <T weight="600" style={{ flex: 1 }} numberOfLines={1}>{x.title}</T>
              <Badge label={x.state.replace(/_/g, " ")} color={stateColor(p, x.state)} />
            </View>
            <T muted size={12} numberOfLines={2}>
              {[x.account, x.category, x.last ? `${x.last.action} ${x.last.ok === false ? "failed" : x.last.ok ? "ok" : ""} ${relTime(x.last.at)}`.trim() : null].filter(Boolean).join(" · ")}
            </T>
          </Card>
        )} />
    )}</Loading>
  );
}

function Repos() {
  const p = usePalette();
  const f = useFetch(() => api.repos());
  return (
    <Loading f={f}>{(d) => (
      <FlatList data={d.repos} keyExtractor={(x) => x.id} contentContainerStyle={st.list} refreshing={f.refreshing} onRefresh={f.pull}
        ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>No repos yet.</T>}
        ListFooterComponent={<T muted size={12}>{FOOT}</T>}
        renderItem={({ item: r }) => (
          <Card style={st.card}>
            <View style={st.row}>
              <T weight="600" style={{ flex: 1 }} numberOfLines={1}>{r.name}</T>
              <Badge label={r.status} color={stateColor(p, r.status)} />
            </View>
            <T muted size={12} numberOfLines={1} selectable>{r.url}</T>
            <T muted size={12} numberOfLines={2}>
              {[r.default_branch, r.map_status !== "none" ? `map ${r.map_status}` : null, r.last_fetch_at ? `fetched ${relTime(r.last_fetch_at)}` : null].filter(Boolean).join(" · ")}
            </T>
            {r.error && <T size={12} style={{ color: p.bad }} numberOfLines={3}>{r.error}</T>}
          </Card>
        )} />
    )}</Loading>
  );
}

function Skills() {
  const p = usePalette();
  const { nameOf } = useStore();
  const f = useFetch(() => api.skills());
  return (
    <Loading f={f}>{(d) => {
      const pending = d.drafts.filter((x) => x.status === "pending");
      return (
        <FlatList data={d.skills} keyExtractor={(x) => x.name} contentContainerStyle={st.list} refreshing={f.refreshing} onRefresh={f.pull}
          ListHeaderComponent={pending.length ? (
            <Card style={[st.card, { borderColor: p.warn }]}>
              <T weight="600">{pending.length} skill draft{pending.length === 1 ? "" : "s"} waiting for review</T>
              <T muted size={12}>{pending.map((x) => x.name).join(", ")}. Review them on the portal.</T>
            </Card>
          ) : null}
          ListEmptyComponent={<T muted style={{ textAlign: "center", marginTop: 32 }}>No skills yet.</T>}
          renderItem={({ item: s }) => (
            <Card style={st.card}>
              <T weight="600" numberOfLines={1}>{s.name}</T>
              <T muted size={13} numberOfLines={3}>{s.description}</T>
              <T muted size={12} numberOfLines={2}>
                {s.agents.length ? s.agents.map((a) => nameOf(a) ?? a).join(", ") : "No agents"} · {relTime(s.updated_at)}
              </T>
            </Card>
          )} />
      );
    }}</Loading>
  );
}

const st = StyleSheet.create({
  list: { padding: 16, gap: 8 },
  card: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
