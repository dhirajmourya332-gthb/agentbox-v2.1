import type { FastifyInstance } from "fastify";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent, rootOf, type Agent } from "./agents.ts";
import { roomDocuments, roomView } from "./work.ts";
import { counts, itemsOf, roadmapsOf } from "./roadmaps.ts";
import { roomServices } from "./hosting.ts";
import { crewIdOf, crewName } from "./crews.ts";

/**
 * Linked work: the owner links another piece of work (a task or task room, usually another crew's)
 * to this one, and every task in this work may then READ it: its progress and roadmap, its
 * conversation, its documents and what it hosts. Reading only: crews stay separate teams, so nobody
 * here can hand work to or message the other work's agents. Only the owner links and unlinks
 * (the portal); agents see the links in their instructions and read with linked_work tools.
 */

run(`CREATE TABLE IF NOT EXISTS work_links (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,               -- the work that reads (its root task)
  linked_id TEXT NOT NULL,             -- the work it may read (its root task)
  created_at TEXT NOT NULL,
  UNIQUE (room_id, linked_id)
)`);

export const LIMITS = { links: 8, messages: 40, messageChars: 3000 };

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The root task of the work an instance is in (itself for a task the owner started). */
function workRootOf(instanceId: string): Agent {
  const a = getAgent(instanceId);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  return rootOf(a);
}

type Link = { id: string; room_id: string; linked_id: string; created_at: string };

/** A piece of work, as a line someone can recognise: its title, who leads it, its crew and state. */
function describe(rootId: string) {
  const r = getAgent(rootId);
  if (!r) return { id: rootId, label: "(deleted work)", name: "", crew: null as string | null, crew_name: "no crew", status: "deleted" };
  const crew = crewIdOf(r);
  return { id: r.id, label: r.label ?? r.name, name: r.name, crew, crew_name: crewName(crew), status: r.retired_at ? "done" : "live" };
}

export function linksOf(instanceId: string) {
  const root = workRootOf(instanceId);
  const links = all<Link>(`SELECT * FROM work_links WHERE room_id = ? ORDER BY created_at`, root.id);
  const from = all<Link>(`SELECT * FROM work_links WHERE linked_id = ? ORDER BY created_at`, root.id);
  return {
    room_id: root.id,
    links: links.map((l) => ({ id: l.id, created_at: l.created_at, work: describe(l.linked_id) })),
    linked_from: from.map((l) => ({ id: l.id, created_at: l.created_at, work: describe(l.room_id) })),
  };
}

export function addLink(instanceId: string, targetId: unknown) {
  const root = workRootOf(instanceId);
  const target = workRootOf(String(targetId ?? ""));
  if (target.id === root.id) throw httpError(400, "That's this work itself");
  if (get(`SELECT 1 FROM work_links WHERE room_id = ? AND linked_id = ?`, root.id, target.id)) return linksOf(root.id);
  const n = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM work_links WHERE room_id = ?`, root.id)?.n ?? 0) as number;
  if (n >= LIMITS.links) throw httpError(400, `At most ${LIMITS.links} linked pieces of work`);
  run(`INSERT INTO work_links (id, room_id, linked_id, created_at) VALUES (?, ?, ?, ?)`, newId(), root.id, target.id, now());
  publish({ type: "links.updated", roomId: root.id });
  return linksOf(root.id);
}

export function removeLink(id: string) {
  const l = get<Link>(`SELECT * FROM work_links WHERE id = ?`, id);
  if (!l) throw httpError(404, "No such link");
  run(`DELETE FROM work_links WHERE id = ?`, id);
  publish({ type: "links.updated", roomId: l.room_id });
  return { ok: true };
}

// --- what agents see -------------------------------------------------------------------------------

/** The linked work an agent may read, in its instructions (empty when there's none). */
export function linkedSection(agent: Agent): string {
  if (!agent.base_agent_id) return "";
  let links: ReturnType<typeof linksOf>["links"];
  try { links = linksOf(agent.id).links; } catch { return ""; }
  if (!links.length) return "";
  return `## Linked work (read-only)
The owner linked this other work to yours so you can follow it: its progress, roadmap,
conversation, documents and hosted links. Read it with \`mcp__team__read_linked_work\` (work = the
title or id below) whenever it matters to your task, e.g. before planning or when it may have moved on.
It's for reading only: you can't hand work to or message its agents (other crews are separate teams).
If you need something from it, tell the owner in your reply.
${links.map((l) => `- "${l.work.label}" (${l.work.crew_name} crew, led by ${l.work.name}; ${l.work.status}) — id ${l.work.id}`).join("\n")}
`;
}

function mustLinked(agent: Agent, ref: string) {
  const { links } = linksOf(agent.id);
  const k = ref.trim().toLowerCase();
  const hit = links.find((l) => l.work.id === ref.trim()) ?? links.find((l) => l.work.label.toLowerCase() === k)
    ?? links.find((l) => l.work.label.toLowerCase().includes(k));
  if (!hit) {
    throw new Error(links.length
      ? `No linked work matching "${ref}". Linked: ${links.map((l) => `"${l.work.label}" (${l.work.id})`).join(", ")}.`
      : "No work is linked to yours. Only the owner links work.");
  }
  if (hit.work.status === "deleted") throw new Error("That work was deleted.");
  return hit.work;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
// Cards in a conversation hold an id, not text.
const CARD_AUTHORS = new Set(["plan", "review", "roadmap", "setup_request", "integration", "approval"]);

export function readLinked(agent: Agent, ref: string, part: string, opts: { limit?: number; before?: number } = {}): string {
  const w = mustLinked(agent, ref);
  const name = (id: string) => (id === "user" ? "Owner" : id === "system" ? "agentbox" : getAgent(id)?.name ?? id);
  const head = `# "${w.label}" (${w.crew_name} crew, led by ${w.name}; ${w.status})`;
  if (part === "progress") {
    const v = roomView(w.id);
    const tasks = (v.members as any[]).map((m) => `- ${m.name} "${m.label ?? ""}": ${m.status}${m.current ? `, working on "${m.current}"` : ""}${m.queued ? `, ${m.queued} queued` : ""}`);
    const maps = roadmapsOf(w.id).map((r: any) => {
      const items = itemsOf(r.id);
      const c = counts(items);
      return [`## Roadmap: ${r.title} (${c.done}/${c.total} done${c.blocked ? `, ${c.blocked} blocked` : ""})`,
        ...items.map((i) => `- [${i.status}] ${i.phase ? `${i.phase} · ` : ""}${i.title}${i.owner ? ` (${i.owner})` : ""}${i.note ? ` — ${i.note}` : ""}${i.link ? ` ${i.link}` : ""}`)].join("\n");
    });
    const last = (v.messages as any[]).filter((m) => !CARD_AUTHORS.has(m.author) && m.author !== "system").at(-1);
    return [head, "", "## Tasks", ...tasks, "", ...(maps.length ? maps : ["(no roadmap)"]),
      v.workspace ? `\nShared folder (readable): ${v.workspace}` : "",
      last ? `\nLatest message, ${name(last.author)} at ${last.created_at}:\n${clip(last.content, 1500)}` : "",
      "\nMore: part=conversation, documents or services."].filter((x) => x !== "").join("\n");
  }
  if (part === "conversation") {
    const v = roomView(w.id);
    const msgs = (v.messages as any[]).filter((m) => !CARD_AUTHORS.has(m.author));
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), LIMITS.messages);
    const end = Math.max(msgs.length - (opts.before ?? 0), 0);
    const page = msgs.slice(Math.max(end - limit, 0), end);
    if (!page.length) return `${head}\n\nNo messages${opts.before ? " that far back" : ""}.`;
    const older = end - page.length;
    return [head, `Messages ${older + 1}–${end} of ${msgs.length}, oldest first${older ? ` (older ones: before=${msgs.length - older})` : ""}:`, "",
      ...page.map((m) => `### ${name(m.author)} · ${m.created_at}\n${clip(m.content, LIMITS.messageChars)}`)].join("\n\n");
  }
  if (part === "documents") {
    const docs = roomDocuments(w.id);
    const v = roomView(w.id);
    return [head, "", docs.length ? `${docs.length} documents (read them with the Read tool):` : "No documents yet.",
      ...docs.slice(0, 60).map((d: any) => `- ${d.path} (${d.modified}${d.author ? `, ${name(d.author)}` : ""})`),
      v.workspace ? `\nShared folder: ${v.workspace}` : ""].join("\n");
  }
  if (part === "services") {
    const svcs = roomServices(w.id).filter((s: any) => s.status === "running");
    return [head, "", svcs.length ? "Running now:" : "Nothing hosted right now.", ...svcs.map((s: any) => `- ${s.name}: ${s.url} (local ${s.local_url})`)].join("\n");
  }
  throw new Error(`part is one of progress, conversation, documents, services`);
}

export function registerLinkRoutes(app: FastifyInstance) {
  // :id is any task in the work; links belong to its root.
  app.get("/api/work/:id/links", async (req) => linksOf((req.params as any).id));
  app.post("/api/work/:id/links", async (req) => addLink((req.params as any).id, (req.body as any)?.work_id));
  app.delete("/api/links/:id", async (req) => removeLink((req.params as any).id));
}
