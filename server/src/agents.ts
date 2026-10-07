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
};

export function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export const homeOf = (a: Pick<Agent, "slug">) => path.join(AGENTS_ROOT, a.slug);
export const instructionsPath = (a: Pick<Agent, "slug">) => path.join(homeOf(a), "CLAUDE.md");
export const memoryDir = (a: Pick<Agent, "slug">) => path.join(homeOf(a), "memory");

export const listAgents = () => all<Agent>(`SELECT * FROM agents ORDER BY created_at`);
export const getAgent = (id: string) => get<Agent>(`SELECT * FROM agents WHERE id = ?`, id);

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

export function updateAgent(id: string, patch: Partial<Pick<Agent, "title" | "summary" | "model" | "max_turns">>) {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent");
  if (patch.model && !MODELS.includes(patch.model as any)) throw new Error(`Unknown model ${patch.model}`);
  const next = { ...a, ...patch };
  run(
    `UPDATE agents SET title = ?, summary = ?, model = ?, max_turns = ? WHERE id = ?`,
    next.title, next.summary, next.model, next.max_turns, id,
  );
  publish({ type: "agent.updated", agent: next });
  return next;
}

export function deleteAgent(id: string) {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent");
  run(`DELETE FROM agents WHERE id = ?`, id);
  fs.rmSync(homeOf(a), { recursive: true, force: true });
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
