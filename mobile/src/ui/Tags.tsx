import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { showDialog } from "./dialog";
import { T } from "./kit";
import { usePalette } from "./theme";

/**
 * Tags on work (server/src/tags.ts), as on the portal: the owner's labels for a context
 * ("brandsek", "infra"). Work filters by one; a room's header edits them; New task sets them.
 */

/** Same form the server keeps: lowercase, one word ("mobile app" → "mobile-app"). */
export const cleanTag = (s: string) =>
  s.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_.-]/gu, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/** The same steady hue per tag as the portal. */
export function tagHue(tag: string) {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

export function TagChip({ tag, on, onPress, onRemove, small }: { tag: string; on?: boolean; onPress?: () => void; onRemove?: () => void; small?: boolean }) {
  const p = usePalette();
  const h = tagHue(tag);
  const body = (
    <View style={[st.chip, small && st.small, {
      borderColor: `hsla(${h}, 50%, 50%, ${on ? 1 : 0.5})`, backgroundColor: `hsla(${h}, 60%, 50%, ${on ? 0.32 : 0.12})`,
    }]}>
      <T size={small ? 12 : 13} weight={on ? "600" : undefined} style={{ color: p.text }}>#{tag}</T>
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove tag ${tag}`}>
          <T muted size={13}>✕</T>
        </Pressable>
      )}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!on }} accessibilityLabel={`Tag ${tag}`}>
      {body}
    </Pressable>
  );
}

/** Tags in use on the listed work, most used first. */
export function useListedTags(): string[] {
  const { work } = useStore();
  return useMemo(() => {
    const n = new Map<string, number>();
    for (const r of [...work.live, ...work.done]) for (const t of r.root.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [work]);
}

/** Every tag in use, including on older work the list no longer shows. */
export function useKnownTags(): string[] {
  const listed = useListedTags();
  const [server, setServer] = useState<string[]>([]);
  useEffect(() => { api.workTags().then((r) => setServer(r.tags.map((t) => t.tag))).catch(() => {}); }, []);
  return useMemo(() => [...listed, ...server.filter((t) => !listed.includes(t))], [listed, server]);
}

/** A text box that adds a tag on submit, with the tags already in use to tap. */
function AddTag({ have, onAdd, onClose }: { have: string[]; onAdd: (t: string) => void; onClose?: () => void }) {
  const p = usePalette();
  const known = useKnownTags().filter((t) => !have.includes(t)).slice(0, 10);
  const [v, setV] = useState("");
  const add = () => { const t = cleanTag(v); if (t && !have.includes(t)) onAdd(t); setV(""); };
  return (
    <View style={{ gap: 6, width: "100%" }}>
      <TextInput value={v} onChangeText={(x) => (x.endsWith(",") ? (setV(x.slice(0, -1)), add()) : setV(x))} onSubmitEditing={() => { add(); onClose?.(); }}
        autoFocus={!!onClose} autoCapitalize="none" autoCorrect={false} maxLength={30} placeholder="New tag, e.g. brandsek" placeholderTextColor={p.muted}
        onBlur={() => { add(); onClose?.(); }} accessibilityLabel="Add a tag" returnKeyType="done"
        style={[st.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]} />
      {known.length > 0 && (
        <View style={st.wrap}>{known.map((t) => <TagChip key={t} tag={t} small onPress={() => onAdd(t)} />)}</View>
      )}
    </View>
  );
}

/** The tags of a piece of work, editable in place (a room's header). */
export function TagEditor({ workId, tags }: { workId: string; tags: string[] }) {
  const p = usePalette();
  const [adding, setAdding] = useState(false);
  const save = (next: string[]) => {
    api.setWorkTags(workId, next).catch((e: unknown) => showDialog("Couldn't change the tags", e instanceof Error ? e.message : ""));
  };
  return (
    <View style={st.wrap}>
      {tags.map((t) => <TagChip key={t} tag={t} small onRemove={() => save(tags.filter((x) => x !== t))} />)}
      {!adding && tags.length < 8 && (
        <Pressable onPress={() => setAdding(true)} accessibilityRole="button" accessibilityLabel="Add a tag"
          style={[st.chip, st.small, { borderStyle: "dashed", borderColor: p.border }]}>
          <T muted size={12}>+ {tags.length ? "" : "tag"}</T>
        </Pressable>
      )}
      {adding && <AddTag have={tags} onAdd={(t) => save([...tags, t])} onClose={() => setAdding(false)} />}
    </View>
  );
}

/** Tags for a form (New task): nothing is sent until the form is. */
export function TagInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <View style={{ gap: 6 }}>
      {value.length > 0 && <View style={st.wrap}>{value.map((t) => <TagChip key={t} tag={t} onRemove={() => onChange(value.filter((x) => x !== t))} />)}</View>}
      {value.length < 8 && <AddTag have={value} onAdd={(t) => onChange([...value, t])} />}
    </View>
  );
}

const FILTER_KEY = "agentbox.work.tag";
export const UNTAGGED = "-";
export const matchesFilter = (tags: string[] | undefined, f: string) => !f || (f === UNTAGGED ? !(tags ?? []).length : (tags ?? []).includes(f));

/** Work's filter: "" (everything), a tag, or "-" (untagged only). Remembered on this phone. */
export function useWorkFilter(): [string, (v: string) => void] {
  const [v, setV] = useState("");
  useEffect(() => { SecureStore.getItemAsync(FILTER_KEY).then((x) => { if (x) setV(x); }).catch(() => {}); }, []);
  const set = (next: string) => { setV(next); SecureStore.setItemAsync(FILTER_KEY, next).catch(() => {}); };
  return [v, set];
}

/** The row of filter chips above Work: All · each tag · untagged. */
export function TagFilterBar({ tags, value, onChange, untagged }: { tags: string[]; value: string; onChange: (v: string) => void; untagged: boolean }) {
  const p = usePalette();
  const plain = (label: string, on: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={[st.chip, { borderColor: on ? p.muted : p.border, backgroundColor: on ? p.surface2 ?? p.surface : "transparent" }]}>
      <T size={13} muted={!on} weight={on ? "600" : undefined}>{label}</T>
    </Pressable>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.bar} accessibilityLabel="Show work tagged">
      {plain("All", !value, () => onChange(""))}
      {tags.map((t) => <TagChip key={t} tag={t} on={value === t} onPress={() => onChange(value === t ? "" : t)} />)}
      {untagged && plain("untagged", value === UNTAGGED, () => onChange(value === UNTAGGED ? "" : UNTAGGED))}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 30, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1 },
  small: { minHeight: 24, paddingHorizontal: 9 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  bar: { gap: 6, paddingHorizontal: 16, paddingVertical: 8, alignItems: "center" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15 },
});
