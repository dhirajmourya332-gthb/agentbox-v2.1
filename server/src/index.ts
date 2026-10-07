import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { all, get } from "./db.ts";
import { subscribe } from "./bus.ts";
import {
  createAgent, deleteAgent, dmThreadOf, getAgent, listAgents, listMemory, listRetired, readInstructions, retireReplica, spawnReplica,
  updateAgent, writeInstructions,
} from "./agents.ts";
import { isPaused, displayState as screen, releaseDisplay, setPaused, takeDisplay } from "./control.ts";
import { activity, graph } from "./activity.ts";
import { openTasksOf, pauseAll, runningCount, agentStatus, currentUsage, resetSession, sendMessage, stopTask, threadView } from "./runner.ts";
import { CORE_QUESTIONS, TEMPLATES, draft, followUps } from "./interview.ts";
import {
  createRoutine, deleteRoutine, describeCron, forgetAgentRoutines, getRoutine, listRoutines, routineRuns, runRoutine, startRoutines,
  updateRoutine, validateCron,
} from "./routines.ts";
import { continueGroup, createGroup, deleteGroup, getGroup, listGroups, postAsOwner, updateGroup } from "./groups.ts";
import {
  approveDraft, deleteSkill, getDraft, getSkill, listDrafts, listSkills, rejectDraft, saveSkill, seedSkills,
  setAgentSkills, setSkillAgents, skillsOf,
} from "./skills.ts";
import { health } from "./health.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 7700);
const webDist = path.resolve(here, "../../web/dist");

const app = Fastify({ logger: { level: "info" } });
await app.register(fastifyWebsocket);

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
app.setErrorHandler((err: any, _req, reply) => {
  const status = err.statusCode ?? 400;
  if (status >= 500) app.log.error(err);
  reply.status(status).send({ error: err.message });
});

const agentView = (a: ReturnType<typeof getAgent> & {}) => ({
  ...a,
  ...agentStatus(a.id),
  dm_thread_id: dmThreadOf(a.id),
  skills: skillsOf(a.id),
});
const mustAgent = (id: string) => {
  const a = getAgent(id);
  if (!a) throw new HttpError(404, "No such agent");
  return a;
};

// --- system -----------------------------------------------------------------
app.get("/api/health", health);
app.get("/api/state", async () => ({
  agents: listAgents().map(agentView), usage: currentUsage(), groups: listGroups(), paused: isPaused(), display: screen(),
  retired: listRetired().map((a) => ({ id: a.id, name: a.name, color: a.color, base_agent_id: a.base_agent_id })),
}));

// --- owner controls -------------------------------------------------------------
app.post("/api/pause", async (req) => {
  pauseAll((req.body as any)?.stopRunning !== false);
  return { paused: true };
});
app.post("/api/resume", async () => {
  setPaused(false);
  return { paused: false };
});
app.get("/api/control", async () => ({ paused: isPaused(), display: screen(), running: runningCount() }));
app.post("/api/display/take", async () => {
  takeDisplay();
  return screen();
});
app.post("/api/display/release", async () => {
  releaseDisplay();
  return { ok: true };
});

// --- activity ---------------------------------------------------------------------
app.get("/api/activity", async (req) => {
  const q = req.query as any;
  return activity({ limit: Math.min(Number(q.limit ?? 150), 500), agent: q.agent || undefined });
});
app.get("/api/graph", async (req) => graph(String((req.query as any).since ?? "")));

// --- creating agents (the interview) ------------------------------------------
app.get("/api/interview", async () => ({ questions: CORE_QUESTIONS, templates: TEMPLATES }));
app.post("/api/interview/follow-ups", async (req) => followUps((req.body as any).answers ?? {}));
app.post("/api/interview/draft", async (req) => {
  const body = req.body as any;
  return draft(body.answers ?? {}, body.extra ?? []);
});

// --- agents -----------------------------------------------------------------
app.post("/api/agents", async (req) => {
  const b = req.body as any;
  for (const k of ["name", "title", "model", "instructions"]) {
    if (typeof b?.[k] !== "string" || !b[k].trim()) throw new HttpError(400, `Missing ${k}`);
  }
  const agent = createAgent(b);
  if (Array.isArray(b.skills) && b.skills.length) setAgentSkills(agent.id, b.skills);
  return agentView(agent);
});
app.get("/api/agents/:id", async (req) => {
  const a = mustAgent((req.params as any).id);
  return { agent: agentView(a), instructions: readInstructions(a), memory: listMemory(a) };
});
app.patch("/api/agents/:id", async (req) => agentView(updateAgent(mustAgent((req.params as any).id).id, req.body as any)));
app.put("/api/agents/:id/instructions", async (req) => {
  const a = mustAgent((req.params as any).id);
  if (a.base_agent_id) throw new HttpError(400, "Replicas use their base agent's instructions; edit those instead");
  const text = (req.body as any)?.text;
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Instructions can't be empty");
  writeInstructions(a, text);
  return { ok: true };
});
app.post("/api/agents/:id/replicas", async (req) => agentView(spawnReplica(mustAgent((req.params as any).id).id)));
app.post("/api/agents/:id/retire", async (req) => {
  const a = mustAgent((req.params as any).id);
  const open = openTasksOf(a.id);
  if (open.length) throw new HttpError(409, `${a.name} still has ${open.length} task(s) running or queued; stop them first`);
  retireReplica(a.id);
  return { ok: true };
});
app.delete("/api/agents/:id", async (req) => {
  const a = mustAgent((req.params as any).id);
  if (agentStatus(a.id).status === "working" || openTasksOf(a.id).length) throw new HttpError(409, `${a.name} is working; stop its tasks first`);
  const busyReplica = (all(`SELECT id, name FROM agents WHERE base_agent_id = ? AND retired_at IS NULL`, a.id) as any[])
    .find((r) => openTasksOf(r.id).length);
  if (busyReplica) throw new HttpError(409, `${busyReplica.name} (a replica) is working; stop its tasks first`);
  deleteAgent(a.id);
  forgetAgentRoutines(a.id);
  return { ok: true };
});
app.post("/api/agents/:id/reset-session", async (req) => {
  const a = mustAgent((req.params as any).id);
  resetSession(a.id, dmThreadOf(a.id));
  return { ok: true };
});

app.put("/api/agents/:id/skills", async (req) => {
  const a = mustAgent((req.params as any).id);
  setAgentSkills(a.id, (req.body as any)?.skills ?? []);
  return agentView(a);
});

// --- skills -----------------------------------------------------------------
app.get("/api/skills", async () => ({ skills: listSkills(), drafts: listDrafts() }));
app.get("/api/skills/:name", async (req) => {
  const s = getSkill((req.params as any).name);
  if (!s) throw new HttpError(404, "No such skill");
  return s;
});
app.post("/api/skills", async (req) => {
  const b = req.body as any;
  const s = saveSkill({ name: String(b?.name ?? ""), description: String(b?.description ?? ""), body: String(b?.body ?? "") }, { create: true });
  if (Array.isArray(b?.agents)) setSkillAgents(s.name, b.agents);
  return getSkill(s.name);
});
app.put("/api/skills/:name", async (req) => {
  const b = req.body as any;
  const name = (req.params as any).name;
  saveSkill({ name, description: String(b?.description ?? ""), body: String(b?.body ?? "") }, { create: false });
  if (Array.isArray(b?.agents)) setSkillAgents(name, b.agents);
  return getSkill(name);
});
app.delete("/api/skills/:name", async (req) => {
  deleteSkill((req.params as any).name);
  return { ok: true };
});
app.get("/api/skill-drafts/:id", async (req) => {
  const d = getDraft((req.params as any).id);
  if (!d) throw new HttpError(404, "No such draft");
  return { draft: d, existing: getSkill(d.name) ?? null };
});
app.post("/api/skill-drafts/:id/approve", async (req) => {
  const b = req.body as any;
  approveDraft((req.params as any).id, {
    name: String(b?.name ?? ""), description: String(b?.description ?? ""), body: String(b?.body ?? ""),
    agents: Array.isArray(b?.agents) ? b.agents : [],
  });
  return { ok: true };
});
app.post("/api/skill-drafts/:id/reject", async (req) => {
  rejectDraft((req.params as any).id);
  return { ok: true };
});

// --- conversations ----------------------------------------------------------
app.get("/api/threads/:id", async (req) => threadView((req.params as any).id));
app.post("/api/threads/:id/messages", async (req) => {
  const threadId = (req.params as any).id;
  const text = (req.body as any)?.text;
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Message is empty");
  const thread = get(`SELECT * FROM threads WHERE id = ?`, threadId);
  if (!thread) throw new HttpError(404, "No such thread");
  if (thread.kind === "group") return postAsOwner(threadId, text.trim());
  if (thread.kind !== "dm") throw new HttpError(400, "Handoff threads between agents are read-only");
  return sendMessage(thread.agent_id, threadId, text.trim());
});
app.post("/api/tasks/:id/stop", async (req) => {
  stopTask((req.params as any).id);
  return { ok: true };
});

// --- tasks (the board) -------------------------------------------------------
app.get("/api/tasks", async (req) => {
  const q = req.query as any;
  const limit = Math.min(Number(q.limit ?? 200), 500);
  return all(
    `SELECT id, agent_id, thread_id, source, title, status, from_agent_id, parent_task_id, depth, error, cost_usd,
            created_at, started_at, finished_at,
            (SELECT COUNT(*) FROM tasks c WHERE c.parent_task_id = tasks.id AND c.source = 'agent') AS children
     FROM tasks WHERE source != 'result' OR ? = '1'
     ORDER BY created_at DESC LIMIT ?`,
    String(q.results ?? "0"), limit,
  );
});
app.get("/api/tasks/:id", async (req) => {
  const id = (req.params as any).id;
  const task = get(`SELECT * FROM tasks WHERE id = ?`, id);
  if (!task) throw new HttpError(404, "No such task");
  // Walk up to the root, then return the whole tree under it.
  let root = task;
  for (let i = 0; i < 20 && root.parent_task_id; i++) root = get(`SELECT * FROM tasks WHERE id = ?`, root.parent_task_id) ?? root;
  const tree = all(
    `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT tasks.id FROM tasks JOIN t ON tasks.parent_task_id = t.id)
     SELECT tasks.id, agent_id, thread_id, source, title, status, from_agent_id, parent_task_id, depth, error,
            created_at, started_at, finished_at
     FROM tasks JOIN t USING (id) ORDER BY created_at`,
    root.id,
  );
  const steps = all(`SELECT * FROM steps WHERE task_id = ? ORDER BY seq`, id);
  return { task, tree, steps };
});
app.get("/api/agents/:id/threads", async (req) => {
  const a = mustAgent((req.params as any).id);
  return all(
    `SELECT id, kind, agent_id, peer_agent_id, name, created_at,
            (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id) AS last_at
     FROM threads WHERE agent_id = ? ORDER BY kind = 'dm' DESC, last_at DESC`,
    a.id,
  );
});

// --- groups -----------------------------------------------------------------
const groupInput = (b: any) => ({
  name: String(b?.name ?? ""), purpose: String(b?.purpose ?? ""),
  members: Array.isArray(b?.members) ? b.members.map(String) : [], lead: b?.lead ? String(b.lead) : null,
});
app.get("/api/groups", async () => listGroups());
app.post("/api/groups", async (req) => createGroup(groupInput(req.body)));
app.put("/api/groups/:id", async (req) => updateGroup((req.params as any).id, groupInput(req.body)));
app.delete("/api/groups/:id", async (req) => {
  deleteGroup((req.params as any).id);
  return { ok: true };
});
app.post("/api/groups/:id/continue", async (req) => {
  const id = (req.params as any).id;
  if (!getGroup(id)) throw new HttpError(404, "No such group");
  continueGroup(id);
  return { ok: true };
});

// --- routines -------------------------------------------------------------------
const routineInput = (b: any) => ({
  agent_id: String(b?.agent_id ?? ""), name: String(b?.name ?? ""), cron: String(b?.cron ?? ""),
  timezone: String(b?.timezone ?? "UTC"), prompt: String(b?.prompt ?? ""), enabled: b?.enabled !== false,
});
const mustRoutine = (id: string) => {
  const r = getRoutine(id);
  if (!r) throw new HttpError(404, "No such routine");
  return r;
};
app.get("/api/routines", async () => listRoutines());
app.post("/api/routines", async (req) => createRoutine(routineInput(req.body), "owner"));
app.post("/api/routines/preview", async (req) => {
  const b = req.body as any;
  return { next_runs: validateCron(String(b?.cron ?? ""), String(b?.timezone ?? "UTC")), describe: describeCron(String(b?.cron ?? "")) };
});
app.get("/api/routines/:id", async (req) => ({ routine: mustRoutine((req.params as any).id), runs: routineRuns((req.params as any).id) }));
app.put("/api/routines/:id", async (req) => updateRoutine(mustRoutine((req.params as any).id).id, routineInput(req.body)));
app.delete("/api/routines/:id", async (req) => {
  deleteRoutine(mustRoutine((req.params as any).id).id);
  return { ok: true };
});
app.post("/api/routines/:id/run", async (req) => {
  const r = mustRoutine((req.params as any).id);
  const task = runRoutine(r.id, "manual");
  return { started: !!task, routine: getRoutine(r.id) };
});

// --- live events ------------------------------------------------------------
app.get("/api/events", { websocket: true }, (socket) => {
  const off = subscribe((e) => socket.send(JSON.stringify(e)));
  socket.on("close", off);
});

// --- UI ---------------------------------------------------------------------
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
} else {
  app.get("/", async () => "UI not built: run scripts/deploy.sh");
}

seedSkills();
startRoutines();
await app.listen({ host: "0.0.0.0", port });
