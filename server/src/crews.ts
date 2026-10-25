import type { FastifyInstance } from "fastify";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent, listAgents, slugify, type Agent } from "./agents.ts";

/**
 * Crews: separate teams on one agentbox (robotics, software engineering…). Every agent (role) is in at
 * most one crew, and its tasks with it. Agents only see, delegate to and message agents of their own
 * crew; agents in no crew form a pool of their own, so nothing changes until the owner makes crews.
 * The built-in helper stays outside every crew: agents reach it through setup requests, as before.
 * A crew's lead is who new tasks for it go to by default.
 */

run(`CREATE TABLE IF NOT EXISTS crews (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  lead_role_id TEXT,                   -- the agent new tasks for this crew go to by default
  created_at TEXT NOT NULL
)`);

export type Crew = { id: string; slug: string; name: string; summary: string; lead_role_id: string | null; created_at: string };

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

const roles = () => listAgents().filter((a) => !a.base_agent_id && !a.builtin);
const roleOf = (a: Agent) => (a.base_agent_id ? getAgent(a.base_agent_id) ?? a : a);

export function listCrews(): Crew[] {
  return all<Crew>(`SELECT * FROM crews ORDER BY created_at`);
}
export const getCrew = (id: string) => get<Crew>(`SELECT * FROM crews WHERE id = ?`, id);

/** The crew an agent or task (instance) belongs to: its role's; null for no crew. */
export function crewIdOf(a: Agent): string | null {
  const role = roleOf(a);
  return (role as any).crew_id ?? null;
}
export const crewName = (id: string | null) => (id ? getCrew(id)?.name ?? "a deleted crew" : "no crew");

/** May `from` hand work to (or message) `to`? Same crew, or both in none; the helper reaches every crew. */
export const sameCrew = (from: Agent, to: Agent) => !!roleOf(from).builtin || crewIdOf(from) === crewIdOf(to);

/** The agents (roles) an agent works with: its crew's, itself excluded. The helper works for every crew. */
export function crewmates(agent: Agent): Agent[] {
  const mine = crewIdOf(agent);
  const role = roleOf(agent);
  return roles().filter((r) => r.id !== role.id && (role.builtin || crewIdOf(r) === mine));
}

/** The crew's lead: the one chosen, else its first planning agent, else its first agent. */
export function crewLead(crewId: string | null): Agent | undefined {
  const members = roles().filter((r) => crewIdOf(r) === crewId);
  const chosen = crewId ? getCrew(crewId)?.lead_role_id : null;
  return members.find((r) => r.id === chosen) ?? members.find((r) => r.can_scale) ?? members[0];
}

const changed = () => publish({ type: "crews.updated", crews: listCrews() });

function cleanName(v: unknown) {
  const name = String(v ?? "").trim().slice(0, 40);
  if (!name || !slugify(name)) throw httpError(400, "A crew needs a name");
  return name;
}

export function createCrew(input: { name?: unknown; summary?: unknown; members?: unknown }): Crew {
  const name = cleanName(input.name);
  const slug = slugify(name);
  if (get(`SELECT 1 FROM crews WHERE slug = ?`, slug)) throw httpError(409, `A crew called "${name}" already exists`);
  const crew: Crew = { id: newId(), slug, name, summary: String(input.summary ?? "").trim().slice(0, 300), lead_role_id: null, created_at: now() };
  run(`INSERT INTO crews (id, slug, name, summary, lead_role_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    crew.id, crew.slug, crew.name, crew.summary, null, crew.created_at);
  if (Array.isArray(input.members)) for (const m of input.members) setRoleCrew(String(m), crew.id, false);
  changed();
  return getCrew(crew.id)!;
}

export function updateCrew(id: string, patch: { name?: unknown; summary?: unknown; lead_role_id?: unknown }): Crew {
  const crew = getCrew(id);
  if (!crew) throw httpError(404, "No such crew");
  const next = { ...crew };
  if (patch.name !== undefined) {
    next.name = cleanName(patch.name);
    next.slug = slugify(next.name);
    if (get(`SELECT 1 FROM crews WHERE slug = ? AND id != ?`, next.slug, id)) throw httpError(409, `A crew called "${next.name}" already exists`);
  }
  if (patch.summary !== undefined) next.summary = String(patch.summary ?? "").trim().slice(0, 300);
  if (patch.lead_role_id !== undefined) {
    const lead = patch.lead_role_id ? getAgent(String(patch.lead_role_id)) : null;
    if (patch.lead_role_id && (!lead || lead.base_agent_id || crewIdOf(lead) !== id)) throw httpError(400, "The lead must be an agent in this crew");
    next.lead_role_id = lead?.id ?? null;
  }
  run(`UPDATE crews SET slug = ?, name = ?, summary = ?, lead_role_id = ? WHERE id = ?`, next.slug, next.name, next.summary, next.lead_role_id, id);
  changed();
  return next;
}

/** Deleting a crew leaves its agents in no crew; their work and history stay. */
export function deleteCrew(id: string) {
  if (!getCrew(id)) throw httpError(404, "No such crew");
  for (const r of roles().filter((r) => crewIdOf(r) === id)) setRoleCrew(r.id, null, false);
  run(`DELETE FROM crews WHERE id = ?`, id);
  changed();
  return { ok: true };
}

/**
 * Move an agent (role) into a crew, or out of every crew (null). Its live tasks move with it: from
 * their next handoff they only reach the new crew.
 */
export function setRoleCrew(roleId: string, crewId: string | null, announce = true): Agent {
  const role = getAgent(roleId);
  if (!role) throw httpError(404, "No such agent");
  if (role.base_agent_id) throw httpError(400, "Tasks follow their agent's crew; move the agent instead");
  if (role.builtin) throw httpError(400, `${role.name} is built in and works for every crew`);
  if (crewId && !getCrew(crewId)) throw httpError(404, "No such crew");
  const was = (role as any).crew_id ?? null;
  run(`UPDATE agents SET crew_id = ? WHERE id = ?`, crewId, roleId);
  // A lead that leaves its crew stops being its lead.
  if (was && was !== crewId) run(`UPDATE crews SET lead_role_id = NULL WHERE id = ? AND lead_role_id = ?`, was, roleId);
  const next = { ...role, crew_id: crewId } as Agent;
  publish({ type: "agent.updated", agent: next });
  if (announce) changed();
  return next;
}

export function registerCrewRoutes(app: FastifyInstance) {
  app.get("/api/crews", async () => ({ crews: listCrews() }));
  app.post("/api/crews", async (req) => createCrew((req.body ?? {}) as any));
  app.patch("/api/crews/:id", async (req) => updateCrew((req.params as any).id, (req.body ?? {}) as any));
  app.delete("/api/crews/:id", async (req) => deleteCrew((req.params as any).id));
  app.put("/api/agents/:id/crew", async (req) => {
    const crewId = (req.body as any)?.crew_id;
    return setRoleCrew((req.params as any).id, typeof crewId === "string" && crewId ? crewId : null);
  });
}
