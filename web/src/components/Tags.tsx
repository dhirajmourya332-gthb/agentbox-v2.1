import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "./ui.tsx";

/**
 * Tags on work (server/src/tags.ts): the owner's labels for a context ("brandsek", "infra"). The
 * Work list in the rail filters by one; the room and task headers edit them; New task sets them.
 */

/** Same form the server keeps: lowercase, one word ("mobile app" → "mobile-app"). */
export const cleanTag = (s: string) =>
  s.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_.-]/gu, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/** A steady colour per tag, so the same context always looks the same. */
export function tagHue(tag: string) {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

export function TagChip({ tag, onRemove, onClick, pressed, small }: {
  tag: string; onRemove?: () => void; onClick?: () => void; pressed?: boolean; small?: boolean;
}) {
  const style = { "--tag-h": tagHue(tag) } as React.CSSProperties;
  const cls = `tag-chip${small ? " small" : ""}${pressed ? " on" : ""}`;
  if (onClick) {
    return <button type="button" className={cls} style={style} aria-pressed={pressed} onClick={onClick}>#{tag}</button>;
  }
  return (
    <span className={cls} style={style}>
      #{tag}
      {onRemove && <button type="button" className="tag-x" aria-label={`Remove tag ${tag}`} onClick={onRemove}><Icon name="close" size={10} /></button>}
    </span>
  );
}

/** Every tag in use (live and recent work from the store, plus older work from the server), most used first. */
export function useKnownTags(): string[] {
  const { work } = useStore();
  const [server, setServer] = useState<string[]>([]);
  useEffect(() => { api.workTags().then((r) => setServer(r.tags.map((t) => t.tag))).catch(() => {}); }, []);
  return useMemo(() => {
    const n = new Map<string, number>();
    for (const r of [...work.live, ...work.done]) for (const t of r.root.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    for (const t of server) if (!n.has(t)) n.set(t, 0);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [work, server]);
}

/** The tags of the work `rootId` from the Work list (kept current by events); null if it isn't listed. */
export function useWorkTags(rootId: string | null | undefined): string[] | null {
  const { work } = useStore();
  if (!rootId) return null;
  const r = [...work.live, ...work.done].find((x) => x.root.id === rootId);
  return r ? r.root.tags ?? [] : null;
}

/** A small text box that adds a tag on Enter or comma, suggesting tags already in use. */
function AddTag({ have, onAdd, onDone, autoFocus }: { have: string[]; onAdd: (t: string) => void; onDone?: () => void; autoFocus?: boolean }) {
  const known = useKnownTags().filter((t) => !have.includes(t));
  const [v, setV] = useState("");
  const listId = useRef(`tags-${Math.random().toString(36).slice(2)}`).current;
  const add = () => { const t = cleanTag(v); if (t && !have.includes(t)) onAdd(t); setV(""); };
  return (
    <>
      <input className="text tag-input" list={listId} value={v} autoFocus={autoFocus} placeholder="tag" aria-label="Add a tag" maxLength={30}
        onChange={(e) => {
          const next = e.target.value;
          // Picked from the suggestions: add straight away.
          if (known.includes(next)) { onAdd(next); setV(""); return; }
          setV(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Escape") { e.stopPropagation(); setV(""); onDone?.(); }
        }}
        onBlur={() => { add(); onDone?.(); }} />
      <datalist id={listId}>{known.map((t) => <option key={t} value={t} />)}</datalist>
    </>
  );
}

/** Tags of a piece of work, editable in place (headers of a room or a single task). */
export function TagEditor({ workId, tags }: { workId: string; tags: string[] }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: string[]) => { setError(null); api.setWorkTags(workId, next).catch((e) => setError(e.message)); };
  return (
    <span className="tag-row" aria-label="Tags">
      {tags.map((t) => <TagChip key={t} tag={t} small onRemove={() => save(tags.filter((x) => x !== t))} />)}
      {adding
        ? <AddTag have={tags} autoFocus onAdd={(t) => save([...tags, t])} onDone={() => setAdding(false)} />
        : tags.length < 8 && (
          <button type="button" className="tag-add" onClick={() => setAdding(true)} title="Tag this work, to filter the Work list by it">
            <Icon name="plus" size={10} />{tags.length ? "" : "tag"}
          </button>
        )}
      {error && <span className="hint" style={{ color: "var(--bad)" }}>{error}</span>}
    </span>
  );
}

/** Tags for a form (New task): no requests until the form is sent. */
export function TagInput({ value, onChange, id }: { value: string[]; onChange: (v: string[]) => void; id?: string }) {
  const known = useKnownTags().filter((t) => !value.includes(t)).slice(0, 8);
  return (
    <div className="tag-row" id={id}>
      {value.map((t) => <TagChip key={t} tag={t} onRemove={() => onChange(value.filter((x) => x !== t))} />)}
      {value.length < 8 && <AddTag have={value} onAdd={(t) => onChange([...value, t])} />}
      {known.length > 0 && value.length < 8 && (
        <span className="tag-suggest">{known.map((t) => <TagChip key={t} tag={t} small onClick={() => onChange([...value, t])} />)}</span>
      )}
    </div>
  );
}

const FILTER_KEY = "agentbox.work.tag";
/** The Work list's filter: "" (everything), a tag, or "-" (untagged only). Remembered in this browser. */
export function useWorkFilter(): [string, (v: string) => void] {
  const [v, setV] = useState<string>(() => { try { return localStorage.getItem(FILTER_KEY) ?? ""; } catch { return ""; } });
  const set = (next: string) => { setV(next); try { localStorage.setItem(FILTER_KEY, next); } catch { /* storage unavailable */ } };
  return [v, set];
}
export const UNTAGGED = "-";
export const matchesFilter = (tags: string[] | undefined, f: string) => !f || (f === UNTAGGED ? !(tags ?? []).length : (tags ?? []).includes(f));
