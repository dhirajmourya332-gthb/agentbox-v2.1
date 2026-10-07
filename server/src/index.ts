import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { get } from "./db.ts";
import { subscribe } from "./bus.ts";
import {
  createAgent, deleteAgent, dmThreadOf, getAgent, listAgents, listMemory, readInstructions, updateAgent, writeInstructions,
} from "./agents.ts";
import { agentStatus, currentUsage, resetSession, sendMessage, stopTask, threadView } from "./runner.ts";
import { CORE_QUESTIONS, TEMPLATES, draft, followUps } from "./interview.ts";
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
app.get("/api/state", async () => ({ agents: listAgents().map(agentView), usage: currentUsage() }));

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
  const text = (req.body as any)?.text;
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Instructions can't be empty");
  writeInstructions(a, text);
  return { ok: true };
});
app.delete("/api/agents/:id", async (req) => {
  const a = mustAgent((req.params as any).id);
  if (agentStatus(a.id).status === "working") throw new HttpError(409, `${a.name} is working; stop the task first`);
  deleteAgent(a.id);
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
  if (thread.kind !== "dm") throw new HttpError(400, "Group threads arrive in a later milestone");
  return sendMessage(thread.agent_id, threadId, text.trim());
});
app.post("/api/tasks/:id/stop", async (req) => {
  stopTask((req.params as any).id);
  return { ok: true };
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
await app.listen({ host: "0.0.0.0", port });
