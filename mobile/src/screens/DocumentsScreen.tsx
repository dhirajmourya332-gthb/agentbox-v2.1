import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { Props } from "../nav";
import { api } from "../lib/api";
import { isMissingRoute, useStore } from "../lib/store";
import { ErrorBox, Screen } from "../ui/kit";
import { DocumentsList } from "../ui/Live";
import { usePalette } from "../ui/theme";
import { NOT_AVAILABLE } from "../ui/useFetch";

/** Every document the team has (the portal's Documents page), newest first, with a filter. */
export function DocumentsScreen({ navigation }: Props<"Documents">) {
  const p = usePalette();
  const { nameOf } = useStore();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = () => api.allDocuments().then(
    (docs) => docs
      .map((d) => ({ ...d, author: d.author ?? d.role }))
      .filter((d) => !query || d.name.toLowerCase().includes(query) || d.location.toLowerCase().includes(query) || (nameOf(d.role) ?? "").toLowerCase().includes(query)),
    (e: unknown) => { if (isMissingRoute(e)) setMissing(true); throw e; },
  );

  if (missing) return <Screen style={{ padding: 16 }}><ErrorBox text={NOT_AVAILABLE} /></Screen>;
  return (
    <Screen>
      <View style={st.search}>
        <TextInput value={q} onChangeText={setQ} placeholder="Filter by name, folder or agent" placeholderTextColor={p.muted}
          autoCapitalize="none" autoCorrect={false} accessibilityLabel="Filter documents"
          style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]} />
      </View>
      {/* Keyed by the filter: a new filter loads the list again. */}
      <DocumentsList key={query} load={load} nameOf={nameOf}
        onOpen={(d) => navigation.navigate("Doc", { path: d.path, name: d.name })}
        empty={query ? "No document matches." : "No documents yet."} />
    </Screen>
  );
}

const st = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingTop: 10 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15 },
});
