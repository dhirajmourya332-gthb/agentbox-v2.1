import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { paths } from "./config.ts";
import { getAgent, homeOf, listAgents, type Agent } from "./agents.ts";

/**
 * The skill library lives in /skills/<name>/ (SKILL.md + any scripts), in Claude's standard
 * skill format. Assigning a skill links it into the agent's /agents/<slug>/.claude/skills/,
 * and the runner enables exactly the assigned skills. Agents propose new skills as drafts;
 * the owner approves them into the library.
 */

export const SKILLS_ROOT = paths.skills;
const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed-skills");

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export type Skill = { name: string; description: string; body: string; files: string[]; agents: string[]; updated_at: string };
export type Draft = {
  id: string; name: string; description: string; body: string; proposed_by: string; task_id: string | null;
  status: "pending" | "approved" | "rejected"; created_at: string;
};

run(`CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill)
)`);
run(`CREATE TABLE IF NOT EXISTS skill_drafts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

export function checkName(name: string) {
  if (!NAME_RE.test(name)) throw new Error("Skill names are 2–40 characters: lowercase letters, digits and dashes");
}

const dirOf = (name: string) => path.join(SKILLS_ROOT, name);
const skillFile = (name: string) => path.join(dirOf(name), "SKILL.md");

function parse(text: string): { description: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { description: "", body: text };
  const desc = m[1].match(/^description:\s*(.*)$/m)?.[1] ?? "";
  return { description: desc.replace(/^["']|["']$/g, "").trim(), body: m[2].replace(/^\n+/, "") };
}

function render(name: string, description: string, body: string) {
  const oneLine = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine)}\n---\n\n${body.trim()}\n`;
}

function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  });
}

const assignedTo = (name: string) =>
  all<{ agent_id: string }>(`SELECT agent_id FROM agent_skills WHERE skill = ?`, name).map((r) => r.agent_id);
/** An instance uses its agent's skills. */
export const skillsOf = (agentId: string) =>
  all<{ skill: string }>(
    `SELECT skill FROM agent_skills WHERE agent_id = COALESCE((SELECT base_agent_id FROM agents WHERE id = ?), ?) ORDER BY skill`,
    agentId, agentId,
  )
    .map((r) => r.skill)
    .filter((s) => fs.existsSync(skillFile(s)));

export function listSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(skillFile(e.name)))
    .map((e) => getSkill(e.name)!)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): Skill | undefined {
  if (!NAME_RE.test(name) || !fs.existsSync(skillFile(name))) return undefined;
  const { description, body } = parse(fs.readFileSync(skillFile(name), "utf8"));
  return {
    name, description, body,
    files: listFiles(dirOf(name)).filter((f) => f !== "SKILL.md"),
    agents: assignedTo(name),
    updated_at: fs.statSync(skillFile(name)).mtime.toISOString(),
  };
}

export function saveSkill(input: { name: string; description: string; body: string }, opts: { create: boolean }) {
  checkName(input.name);
  if (!input.description.trim()) throw new Error("Describe when the skill should be used");
  if (!input.body.trim()) throw new Error("The skill needs instructions");
  const exists = fs.existsSync(skillFile(input.name));
  if (opts.create && exists) throw new Error(`A skill called "${input.name}" already exists`);
  if (!opts.create && !exists) throw new Error("No such skill");
  fs.mkdirSync(dirOf(input.name), { recursive: true });
  fs.writeFileSync(skillFile(input.name), render(input.name, input.description, input.body));
  const skill = getSkill(input.name)!;
  publish({ type: "skill.updated", skill });
  return skill;
}

export function deleteSkill(name: string) {
  if (!getSkill(name)) throw new Error("No such skill");
  const agents = assignedTo(name);
  run(`DELETE FROM agent_skills WHERE skill = ?`, name);
  for (const id of agents) syncLinks(getAgent(id)!);
  fs.rmSync(dirOf(name), { recursive: true, force: true });
  publish({ type: "skill.deleted", name });
}

export const skillExists = (name: string) => NAME_RE.test(name) && fs.existsSync(skillFile(name));

/**
 * Make /agents/<slug>/.claude/skills hold exactly the agent's assigned skills, or `names` when given
 * (the runner adds the skills of the agent's connected, mapped integrations for each turn).
 */
export function syncLinks(agent: Agent, names?: string[]) {
  const dir = path.join(homeOf(agent), ".claude", "skills");
  fs.mkdirSync(dir, { recursive: true });
  const want = new Set((names ?? skillsOf(agent.id)).filter(skillExists));
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    // Only manage our own links; leave anything else the agent put there.
    if (fs.lstatSync(p).isSymbolicLink() && !want.has(entry)) fs.unlinkSync(p);
  }
  for (const name of want) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) fs.symlinkSync(dirOf(name), p);
  }
}

export function setAgentSkills(agentId: string, names: string[]) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error("No such agent");
  if (agent.base_agent_id) throw new Error("Replicas use their base agent's skills; change those instead");
  for (const n of names) if (!getSkill(n)) throw new Error(`No skill called "${n}"`);
  run(`DELETE FROM agent_skills WHERE agent_id = ?`, agentId);
  for (const n of new Set(names)) run(`INSERT INTO agent_skills (agent_id, skill) VALUES (?, ?)`, agentId, n);
  syncLinks(agent);
  for (const n of names) publish({ type: "skill.updated", skill: getSkill(n)! });
  publish({ type: "agent.skills", agentId, skills: skillsOf(agentId) });
}

export function setSkillAgents(name: string, agentIds: string[]) {
  if (!getSkill(name)) throw new Error("No such skill");
  const before = assignedTo(name);
  run(`DELETE FROM agent_skills WHERE skill = ?`, name);
  for (const id of new Set(agentIds)) {
    if (!getAgent(id)) throw new Error("No such agent");
    run(`INSERT INTO agent_skills (agent_id, skill) VALUES (?, ?)`, id, name);
  }
  for (const id of new Set([...before, ...agentIds])) {
    syncLinks(getAgent(id)!);
    publish({ type: "agent.skills", agentId: id, skills: skillsOf(id) });
  }
  publish({ type: "skill.updated", skill: getSkill(name)! });
}

// --- drafts proposed by agents ------------------------------------------------

export const listDrafts = (status = "pending") =>
  all<Draft>(`SELECT * FROM skill_drafts WHERE status = ? ORDER BY created_at DESC`, status);
export const getDraft = (id: string) => get<Draft>(`SELECT * FROM skill_drafts WHERE id = ?`, id);

export function proposeSkill(agentId: string, taskId: string | null, input: { name: string; description: string; body: string }) {
  const name = input.name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  checkName(name);
  const draft: Draft = {
    id: newId(), name, description: input.description.trim(), body: input.body.trim(),
    proposed_by: agentId, task_id: taskId, status: "pending", created_at: now(),
  };
  run(
    `INSERT INTO skill_drafts (id, name, description, body, proposed_by, task_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    draft.id, draft.name, draft.description, draft.body, draft.proposed_by, draft.task_id, draft.status, draft.created_at,
  );
  publish({ type: "draft.updated", draft });
  return draft;
}

export function approveDraft(id: string, edits: { name: string; description: string; body: string; agents: string[] }) {
  const d = getDraft(id);
  if (!d || d.status !== "pending") throw new Error("No pending draft with that id");
  const exists = !!getSkill(edits.name);
  saveSkill(edits, { create: !exists });
  setSkillAgents(edits.name, [...new Set([...(exists ? assignedTo(edits.name) : []), ...edits.agents])]);
  run(`UPDATE skill_drafts SET status = 'approved' WHERE id = ?`, id);
  publish({ type: "draft.updated", draft: { ...d, status: "approved" } });
}

export function rejectDraft(id: string) {
  const d = getDraft(id);
  if (!d || d.status !== "pending") throw new Error("No pending draft with that id");
  run(`UPDATE skill_drafts SET status = 'rejected' WHERE id = ?`, id);
  publish({ type: "draft.updated", draft: { ...d, status: "rejected" } });
}

// --- starter skills ---------------------------------------------------------

/** Copy the starter skills into the library once, on the first start with this version. */
export function seedSkills() {
  if (get(`SELECT 1 FROM meta WHERE key = 'skills_seeded'`)) return;
  fs.mkdirSync(SKILLS_ROOT, { recursive: true });
  if (fs.existsSync(SEED_DIR)) {
    for (const name of fs.readdirSync(SEED_DIR)) {
      if (!fs.existsSync(dirOf(name))) fs.cpSync(path.join(SEED_DIR, name), dirOf(name), { recursive: true });
    }
    // The tech lead files and reviews; give an existing one the matching skills.
    for (const a of listAgents()) {
      if (/tech.?lead/i.test(`${a.slug} ${a.title}`)) {
        setAgentSkills(a.id, [...new Set([...skillsOf(a.id), "file-github-issue", "review-pr"])]);
      }
    }
  }
  run(`INSERT INTO meta (key, value) VALUES ('skills_seeded', ?)`, now());
}
