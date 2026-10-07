import fs from "node:fs";
import path from "node:path";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";

export const AGENTS_ROOT = process.env.AGENTBOX_AGENTS ?? "/agents";
export const WORK_ROOT = process.env.AGENTBOX_WORK ?? "/work";

// docs/UI-DESIGN.md › Agent colours: hues that also step in lightness.
const COLORS = ["#8AB4FF", "#F2B45A", "#C59BFF", "#5BD69A", "#FF8FB1", "#6FD3E0", "#E0D06F", "#B0B8C6"];
export const MODELS = ["opus", "sonnet", "haiku"] as const;

export type Agent = {
  id: string;
  slug: string;
  name: string;
  title: string;
  summary: string;
  model: string;
  color: string;
  max_turns: number;
  created_at: string;
  /** Set on replicas: the agent this is a copy of. */
  base_agent_id?: string | null;
  replica_no?: number | null;
  /** Replicas live in their base agent's home (shared CLAUDE.md, skills, memory). */
  home_slug?: string | null;
  retired_at?: string | null;
  /** On a base agent: how many replicas may run at once (0 = none). */
  max_replicas?: number;
  /** May this agent spawn and retire replicas? */
  can_scale?: number;
};

export function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

type Homed = Pick<Agent, "slug"> & { home_slug?: string | null };
export const homeOf = (a: Homed) => path.join(AGENTS_ROOT, a.home_slug ?? a.slug);
export const instructionsPath = (a: Homed) => path.join(homeOf(a), "CLAUDE.md");
export const memoryDir = (a: Homed) => path.join(homeOf(a), "memory");

/** Active agents (retired replicas excluded), base agents before their replicas. */
export const listAgents = () =>
  all<Agent>(
    `SELECT a.* FROM agents a LEFT JOIN agents b ON b.id = a.base_agent_id
     WHERE a.retired_at IS NULL
     ORDER BY COALESCE(b.created_at, a.created_at), a.replica_no IS NOT NULL, a.replica_no`,
  );
/** Retired replicas, so history can still name them. */
export const listRetired = () => all<Agent>(`SELECT * FROM agents WHERE retired_at IS NOT NULL ORDER BY created_at`);
export const getAgent = (id: string) => get<Agent>(`SELECT * FROM agents WHERE id = ?`, id);
export const replicasOf = (baseId: string) =>
  all<Agent>(`SELECT * FROM agents WHERE base_agent_id = ? AND retired_at IS NULL ORDER BY replica_no`, baseId);
/** The agent whose instructions/skills/memory this one uses (itself unless it's a replica). */
export const baseOf = (a: Agent) => (a.base_agent_id ? getAgent(a.base_agent_id) ?? a : a);

export function readInstructions(a: Agent) {
  try {
    return fs.readFileSync(instructionsPath(a), "utf8");
  } catch {
    return "";
  }
}

export function writeInstructions(a: Agent, text: string) {
  fs.writeFileSync(instructionsPath(a), text.endsWith("\n") ? text : text + "\n");
}

export function createAgent(input: {
  name: string;
  title: string;
  summary: string;
  model: string;
  instructions: string;
  interview: unknown;
}): Agent {
  const slug = slugify(input.name);
  if (!slug) throw new Error("Name needs at least one letter or digit");
  if (get(`SELECT 1 FROM agents WHERE slug = ?`, slug)) throw new Error(`An agent called "${slug}" already exists`);
  if (!MODELS.includes(input.model as any)) throw new Error(`Unknown model ${input.model}`);

  const count = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents`)?.n ?? 0) as number;
  const agent: Agent = {
    id: newId(),
    slug,
    name: input.name.trim(),
    title: input.title.trim(),
    summary: input.summary.trim(),
    model: input.model,
    color: COLORS[count % COLORS.length],
    max_turns: 60,
    created_at: now(),
  };

  const home = homeOf(agent);
  fs.mkdirSync(path.join(home, "memory"), { recursive: true });
  fs.mkdirSync(path.join(home, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  writeInstructions(agent, input.instructions);
  const memIndex = path.join(memoryDir(agent), "MEMORY.md");
  if (!fs.existsSync(memIndex)) {
    fs.writeFileSync(memIndex, `# ${agent.name}'s memory\n\nOne line per memory file: - [Title](file.md) — what it covers\n`);
  }

  run(
    `INSERT INTO agents (id, slug, name, title, summary, model, color, max_turns, interview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent.id, agent.slug, agent.name, agent.title, agent.summary, agent.model, agent.color,
    agent.max_turns, JSON.stringify(input.interview ?? {}), agent.created_at,
  );
  const threadId = newId();
  run(`INSERT INTO threads (id, kind, agent_id, created_at) VALUES (?, 'dm', ?, ?)`, threadId, agent.id, now());

  publish({ type: "agent.created", agent: { ...agent, status: "idle", dm_thread_id: threadId } });
  return agent;
}

export function updateAgent(
  id: string,
  patch: Partial<Pick<Agent, "title" | "summary" | "model" | "max_turns" | "max_replicas" | "can_scale">>,
) {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent");
  if (a.base_agent_id) throw new Error("Replicas follow their base agent; change the base agent instead");
  if (patch.model && !MODELS.includes(patch.model as any)) throw new Error(`Unknown model ${patch.model}`);
  if (patch.max_replicas !== undefined && !(Number.isInteger(patch.max_replicas) && patch.max_replicas >= 0 && patch.max_replicas <= 6)) {
    throw new Error("Max replicas must be 0–6");
  }
  const next = { ...a, ...patch, can_scale: patch.can_scale === undefined ? a.can_scale : patch.can_scale ? 1 : 0 };
  run(
    `UPDATE agents SET title = ?, summary = ?, model = ?, max_turns = ?, max_replicas = ?, can_scale = ? WHERE id = ?`,
    next.title, next.summary, next.model, next.max_turns, next.max_replicas ?? 0, next.can_scale ?? 0, id,
  );
  publish({ type: "agent.updated", agent: next });
  // Replicas run with their base's role and model.
  for (const r of replicasOf(id)) {
    run(`UPDATE agents SET title = ?, summary = ?, model = ?, max_turns = ? WHERE id = ?`, next.title, next.summary, next.model, next.max_turns, r.id);
    publish({ type: "agent.updated", agent: getAgent(r.id) });
  }
  return next;
}

/** Start a replica of `baseId` (coder → coder#1), reusing the lowest free number. */
export function spawnReplica(baseId: string) {
  const base = getAgent(baseId);
  if (!base || base.retired_at) throw new Error("No such agent");
  if (base.base_agent_id) throw new Error(`${base.name} is itself a replica; spawn from ${getAgent(base.base_agent_id)?.name}`);
  const active = replicasOf(base.id);
  const max = base.max_replicas ?? 0;
  if (active.length >= max) {
    throw new Error(max === 0
      ? `${base.name} isn't set up for replicas. The owner can allow them in ${base.name}'s settings.`
      : `${base.name} already has ${active.length} replica(s), the limit (${max}). Retire one first.`);
  }
  const used = new Set(active.map((r) => r.replica_no));
  let n = 1;
  while (used.has(n)) n++;
  const slug = `${base.slug}-${n}`;
  const name = `${base.name}#${n}`;

  const retired = get<Agent>(`SELECT * FROM agents WHERE base_agent_id = ? AND replica_no = ?`, base.id, n);
  if (retired) {
    // Bring the retired row back: same name and history, fresh conversations.
    run(`UPDATE agents SET retired_at = NULL, title = ?, summary = ?, model = ?, max_turns = ? WHERE id = ?`,
      base.title, base.summary, base.model, base.max_turns, retired.id);
    run(`DELETE FROM agent_sessions WHERE agent_id = ?`, retired.id);
    const agent = getAgent(retired.id)!;
    publish({ type: "agent.created", agent: { ...agent, status: "idle", dm_thread_id: dmThreadOf(agent.id) } });
    return agent;
  }
  if (get(`SELECT 1 FROM agents WHERE slug = ?`, slug)) throw new Error(`An agent called "${slug}" already exists`);
  const agent: Agent = {
    id: newId(), slug, name, title: base.title, summary: base.summary, model: base.model, color: base.color,
    max_turns: base.max_turns, created_at: now(), base_agent_id: base.id, replica_no: n, home_slug: base.home_slug ?? base.slug,
    retired_at: null, max_replicas: 0, can_scale: 0,
  };
  run(
    `INSERT INTO agents (id, slug, name, title, summary, model, color, max_turns, interview, created_at, base_agent_id, replica_no, home_slug)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    agent.id, agent.slug, agent.name, agent.title, agent.summary, agent.model, agent.color, agent.max_turns,
    agent.created_at, agent.base_agent_id, agent.replica_no, agent.home_slug,
  );
  const threadId = newId();
  run(`INSERT INTO threads (id, kind, agent_id, created_at) VALUES (?, 'dm', ?, ?)`, threadId, agent.id, now());
  publish({ type: "agent.created", agent: { ...agent, status: "idle", dm_thread_id: threadId } });
  return agent;
}

/** Retire a replica: it leaves the team, its history stays. */
export function retireReplica(id: string) {
  const a = getAgent(id);
  if (!a || a.retired_at) throw new Error("No such replica");
  if (!a.base_agent_id) throw new Error(`${a.name} isn't a replica; only replicas can be retired`);
  run(`UPDATE agents SET retired_at = ? WHERE id = ?`, now(), id);
  run(`DELETE FROM thread_members WHERE agent_id = ?`, id);
  publish({ type: "agent.retired", agentId: id });
}

export function deleteAgent(id: string) {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent");
  if (a.base_agent_id) return retireReplica(id);
  // A base agent takes its replicas with it (they live in its home).
  const replicas = all<Agent>(`SELECT * FROM agents WHERE base_agent_id = ?`, id);
  run(`DELETE FROM agents WHERE id = ?`, id);
  fs.rmSync(homeOf(a), { recursive: true, force: true });
  for (const r of replicas) publish({ type: "agent.deleted", agentId: r.id });
  publish({ type: "agent.deleted", agentId: id });
}

export function dmThreadOf(agentId: string) {
  return get<{ id: string }>(`SELECT id FROM threads WHERE kind = 'dm' AND agent_id = ?`, agentId)!.id;
}

export function listMemory(a: Agent) {
  const dir = memoryDir(a);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((x, y) => (x === "MEMORY.md" ? -1 : y === "MEMORY.md" ? 1 : x.localeCompare(y)))
    .map((file) => ({ file, content: fs.readFileSync(path.join(dir, file), "utf8") }));
}
