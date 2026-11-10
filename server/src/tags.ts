import type { FastifyInstance } from "fastify";
import { all, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent, rootOf, type Agent } from "./agents.ts";

/**
 * Tags on work: the owner's own labels ("brandsek", "infra", "personal") on a top-level task, so
 * the Work list (portal rail, phone) can be filtered to one context. They live on the work's root
 * instance (agents.tags, a JSON array); every task started under it is part of the same work, so
 * tagging any of them tags the root. Tags only sort the owner's view: agents never see them.
 */

export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 24;

/** Lowercase, words joined by "-", only letters, digits, "-", "_" and "."; duplicates dropped. */
export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const out: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_.-]/gu, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
    if (!t) continue;
    if (t.length > MAX_TAG_LEN) throw Object.assign(new Error(`A tag can be at most ${MAX_TAG_LEN} characters ("${t.slice(0, 30)}…")`), { statusCode: 400 });
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw Object.assign(new Error(`At most ${MAX_TAGS} tags on a piece of work`), { statusCode: 400 });
  return out;
}

export function tagsOf(a: Pick<Agent, "tags"> | undefined | null): string[] {
  if (!a?.tags) return [];
  try { const v = JSON.parse(a.tags); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Set the tags of the work `id` belongs to (on its root). */
export function setWorkTags(id: string, tags: unknown) {
  const a = getAgent(id);
  if (!a || !a.base_agent_id) throw Object.assign(new Error("No such task"), { statusCode: 404 });
  const root = rootOf(a);
  const next = normalizeTags(tags);
  run(`UPDATE agents SET tags = ? WHERE id = ?`, next.length ? JSON.stringify(next) : null, root.id);
  publish({ type: "agent.updated", agent: getAgent(root.id)! });
  return { id: root.id, tags: next };
}

/** Every tag in use on the owner's work, most used first (for suggestions). */
export function knownTags() {
  const counts = new Map<string, number>();
  for (const r of all<{ tags: string }>(`SELECT tags FROM agents WHERE base_agent_id IS NOT NULL AND parent_instance_id IS NULL AND tags IS NOT NULL`)) {
    for (const t of tagsOf(r)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) => ({ tag, n }));
}

export function registerTagRoutes(app: FastifyInstance) {
  app.get("/api/work-tags", async () => ({ tags: knownTags() }));
  app.patch("/api/work/:id/tags", async (req) => setWorkTags((req.params as any).id, (req.body as any)?.tags));
}
