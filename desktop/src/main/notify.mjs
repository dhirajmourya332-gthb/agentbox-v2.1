import { Notification } from "electron";

/**
 * "Needs you" on the desktop: every minute, each reachable agentbox's attention list; a new item that
 * needs the owner (a question, a failure, a stall; not plain replies) becomes a notification that
 * opens the work it's about. Reads only.
 */

const seen = new Map(); // box → Set of item ids already notified (or present at the first look)
let timer = null;

export function startNotifier({ boxes, fetcherFor, enabled, onOpen, onCount }) {
  const tick = async () => {
    let total = 0;
    for (const box of boxes()) {
      try {
        const r = await fetcherFor(box)(`${box.url}/api/attention`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) continue;
        const items = (await r.json()) ?? [];
        const needs = (Array.isArray(items) ? items : items.items ?? []).filter((i) => !i.seen_at && i.kind !== "reply");
        total += needs.length;
        const known = seen.get(box.name);
        seen.set(box.name, new Set(needs.map((i) => i.id)));
        if (!known || !enabled()) continue; // the first look only learns what's there
        for (const i of needs.filter((x) => !known.has(x.id)).slice(0, 3)) {
          const n = new Notification({ title: `${box.name}: ${i.kind === "question" ? "asks you" : i.kind === "failed" ? "something failed" : "needs you"}`, body: String(i.title ?? "").slice(0, 200) });
          n.on("click", () => onOpen(box.name, i.room_id ? `#/work/${i.room_id}` : "#/"));
          n.show();
        }
      } catch { /* not reachable right now */ }
    }
    onCount(total);
  };
  timer = setInterval(tick, 60_000);
  setTimeout(tick, 5000);
  return () => clearInterval(timer);
}
