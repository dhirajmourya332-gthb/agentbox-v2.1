import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { all, get } from "./db.ts";
import { subscribe } from "./bus.ts";
import {
  createAgent, deleteAgent, dmThreadOf, getAgent, homeOf, listAgents, listMemory, listRetired, readInstructions, retireReplica, setInstanceMeta,
  spawnInstance, spawnReplica, updateAgent, writeInstructions,
} from "./agents.ts";
import { isPaused, displayState as screen, releaseDisplay, setPaused, takeDisplay } from "./control.ts";
import { activity, graph } from "./activity.ts";
import { checkImages, displayWithImages, saveUpload } from "./uploads.ts";
import { allDocuments, allowed, contentType, documentsForWork, listDocuments } from "./documents.ts";
import { finishTree, roomDocuments, roomView, workList } from "./work.ts";
import { migrateToInstances } from "./migrate.ts";
import { openTasksOf, pauseAll, runningCount, agentStatus, currentUsage, resetSession, sendMessage, stopTask, threadView } from "./runner.ts";
import { CORE_QUESTIONS, TEMPLATES, draft, followUps } from "./interview.ts";
import {
  compactRoutine, createRoutine, deleteRoutine, describeCron, freshRoutine, forgetAgentRoutines, getRoutine, listRoutines, routineRuns, runRoutine, startRoutines,
  updateRoutine, validateCron,
} from "./routines.ts";
import { continueGroup, createGroup, deleteGroup, getGroup, listGroups, postAsOwner, updateGroup } from "./groups.ts";
import {
  approveDraft, deleteSkill, getDraft, getSkill, listDrafts, listSkills, rejectDraft, saveSkill, seedSkills,
  setAgentSkills, setSkillAgents, skillsOf,
} from "./skills.ts";
import { health } from "./health.ts";
import { VoiceError, transcribeVoice } from "./voice.ts";
import { guardApi, registerDeviceAdmin, startMobileGateway } from "./mobile.ts";
import { startPush, wirePush } from "./push.ts";
import { listProgress, startProgress } from "./progress.ts";
import { listAttention, markAllSeen, markRoomSeen, markSeen, onAttention, startAttention } from "./attention.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 7700);
const mobilePort = Number(process.env.AGENTBOX_MOBILE_PORT ?? 7710);
const webDist = path.resolve(here, "../../web/dist");

const app = Fastify({ logger: { level: "info" } });
await app.register(fastifyWebsocket);

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
// Every /api route and /api/events: localhost only (Host, Origin, JSON writes); requests the mobile
// gateway injects are re-checked against its allowlist instead (mobile.ts).
guardApi(app);
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
  home: homeOf(a),
  live_instances: a.base_agent_id ? undefined : listAgents().filter((x) => x.base_agent_id === a.id).length,
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
app.get("/api/agents/:id/documents", async (req) => {
  const a = mustAgent((req.params as any).id);
  if (a.base_agent_id) {
    // An instance: what its own task produced.
    const tasks = all<{ id: string }>(`SELECT id FROM tasks WHERE agent_id = ?`, a.id).map((t) => t.id);
    const threads = all<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ?`, a.id).map((t) => t.id);
    return documentsForWork(tasks, threads);
  }
  // An agent: everything in its home plus what any of its instances wrote.
  const ids = [a.id, ...(all(`SELECT id FROM agents WHERE base_agent_id = ?`, a.id) as any[]).map((r) => r.id)];
  return listDocuments(a, ids);
});
app.get("/api/documents", async () =>
  allDocuments(
    listAgents().filter((a) => !a.base_agent_id),
    (roleId) => (all(`SELECT id FROM agents WHERE base_agent_id = ?`, roleId) as any[]).map((r) => r.id),
  ));

// --- work: tasks (instances) and task rooms ------------------------------------------------
app.get("/api/work", async () => workList());
app.post("/api/work", async (req) => {
  const b = req.body as any;
  const role = mustAgent(String(b?.role_id ?? ""));
  if (role.base_agent_id) throw new HttpError(400, "Pick an agent, not an instance");
  const text = String(b?.text ?? "").trim();
  let images: string[];
  try { images = checkImages(b?.images); } catch (e: any) { throw new HttpError(400, e.message); }
  if (!text && !images.length) throw new HttpError(400, "Say what needs doing");
  const firstLine = text.split("\n")[0] || "Task from an image";
  const label = String(b?.title ?? "").trim() || (firstLine.length > 70 ? firstLine.slice(0, 67) + "…" : firstLine);
  const inst = spawnInstance(role.id, { label, createdBy: "owner" });
  sendMessage(inst.id, dmThreadOf(inst.id)!, text, images);
  return agentView(inst);
});
app.get("/api/work/:id", async (req) => {
  try { return roomView((req.params as any).id); } catch (e: any) { throw new HttpError(404, e.message); }
});
app.get("/api/work/:id/documents", async (req) => roomDocuments((req.params as any).id));
app.post("/api/agents/:id/done", async (req) => {
  const a = mustAgent((req.params as any).id);
  if (!a.base_agent_id) throw new HttpError(400, "Only tasks (instances) can be marked done");
  try { return finishTree(a.id); } catch (e: any) { throw new HttpError(409, e.message); }
});
app.patch("/api/agents/:id/meta", async (req) => {
  const b = req.body as any;
  return agentView(setInstanceMeta(mustAgent((req.params as any).id).id, { label: b?.label, kept: b?.kept }));
});
app.get("/api/groups/:id/documents", async (req) => {
  const id = (req.params as any).id;
  if (!getGroup(id)) throw new HttpError(404, "No such group");
  // The group's own turns plus anything they delegated further.
  const tasks = all<{ id: string }>(
    `WITH RECURSIVE t(id) AS (SELECT id FROM tasks WHERE thread_id = ? UNION ALL SELECT tasks.id FROM tasks JOIN t ON tasks.parent_task_id = t.id)
     SELECT id FROM t`, id,
  ).map((r) => r.id);
  return documentsForWork(tasks, [id]);
});
// What the reader needs to show a file someone linked to.
app.get("/api/file/info", async (req) => {
  const p = String((req.query as any).path ?? "");
  if (!allowed(p)) throw new HttpError(403, "That file isn't available");
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { throw new HttpError(404, "File not found. It may have been moved or deleted."); }
  if (!st.isFile()) throw new HttpError(400, "That's a folder, not a file");
  return { path: p, name: path.basename(p), folder: path.dirname(p), size: st.size, modified: st.mtime.toISOString() };
});
// Serve a document for viewing or download. Only files under /agents or /work.
app.get("/api/file", async (req, reply) => {
  const q = req.query as any;
  const p = String(q.path ?? "");
  if (!allowed(p)) throw new HttpError(403, "That file isn't available");
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { throw new HttpError(404, "File not found"); }
  if (!st.isFile()) throw new HttpError(404, "Not a file");
  const name = path.basename(p).replace(/"/g, "");
  reply.header("content-type", contentType(p));
  reply.header("content-disposition", `${q.download ? "attachment" : "inline"}; filename="${name}"`);
  reply.header("cache-control", "no-store");
  // HTML/SVG from an agent mustn't run scripts against the agentbox UI. (Not applied to PDFs:
  // a sandboxed response stops the browser's built-in PDF viewer.)
  if (/\.(html?|svg)$/i.test(p)) {
    reply.header("content-security-policy", "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src *");
  }
  return reply.send(fs.createReadStream(p));
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
  if (busyReplica) throw new HttpError(409, `${busyReplica.name} (one of its tasks) is working; stop it first`);
  deleteAgent(a.id);
  forgetAgentRoutines(a.id);
  return { ok: true };
});
app.post("/api/agents/:id/reset-session", async (req) => {
  const a = mustAgent((req.params as any).id);
  const thread = dmThreadOf(a.id);
  if (!thread) throw new HttpError(400, "This agent has no conversation; its tasks each have their own");
  resetSession(a.id, thread);
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
app.post("/api/uploads", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
  try { return saveUpload(req.body as any); } catch (e: any) { throw new HttpError(400, e.message); }
});
// Voice input: transcribe and clean up; the text goes back into the box for review, never sent.
// base64 of 15 MB of audio plus the JSON around it.
app.post("/api/voice/transcribe", { bodyLimit: 21 * 1024 * 1024 }, async (req) => {
  try { return await transcribeVoice(req.body); } catch (e: any) {
    if (e instanceof VoiceError) throw new HttpError(e.statusCode, e.message);
    throw new HttpError(500, "Transcription failed");
  }
});
app.post("/api/threads/:id/messages", async (req) => {
  const threadId = (req.params as any).id;
  const text = String((req.body as any)?.text ?? "");
  let images: string[];
  try { images = checkImages((req.body as any)?.images); } catch (e: any) { throw new HttpError(400, e.message); }
  if (!text.trim() && !images.length) throw new HttpError(400, "Message is empty");
  const thread = get(`SELECT * FROM threads WHERE id = ?`, threadId);
  if (!thread) throw new HttpError(404, "No such thread");
  if (thread.kind === "group") return postAsOwner(threadId, displayWithImages(text.trim(), images));
  if (thread.kind !== "dm") throw new HttpError(400, "Handoff threads between agents are read-only");
  const owner = getAgent(thread.agent_id);
  if (!owner?.base_agent_id) throw new HttpError(400, "Start a task for this agent instead (New task)");
  if (owner.retired_at) throw new HttpError(400, "This task is done. Start a new task to continue.");
  return sendMessage(thread.agent_id, threadId, text.trim(), images);
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
  context_mode: b?.context_mode ? String(b.context_mode) : undefined,
  rules: b?.rules === undefined ? undefined : b.rules,
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
app.post("/api/routines/:id/compact", async (req) => {
  try { compactRoutine(mustRoutine((req.params as any).id).id); } catch (e: any) { throw new HttpError(409, e.message); }
  return { ok: true };
});
app.post("/api/routines/:id/fresh", async (req) => {
  try { freshRoutine(mustRoutine((req.params as any).id).id); } catch (e: any) { throw new HttpError(409, e.message); }
  return { ok: true };
});
app.post("/api/routines/:id/run", async (req) => {
  const r = mustRoutine((req.params as any).id);
  const task = runRoutine(r.id, "manual");
  return { started: !!task, routine: getRoutine(r.id) };
});

// --- live progress and "needs you" (docs/CONTRACTS-v2.md § A, B) ---------------------------
app.get("/api/progress", async () => listProgress());
app.get("/api/attention", async () => ({ items: listAttention() }));
app.post("/api/attention/seen-all", async () => ({ seen: markAllSeen() }));
app.post("/api/attention/seen-room/:roomId", async (req) => ({ seen: markRoomSeen((req.params as any).roomId) }));
app.post("/api/attention/:id/seen", async (req) => {
  const item = markSeen((req.params as any).id);
  if (!item) throw new HttpError(404, "No such item");
  return item;
});

// --- paired phones (portal only; refused for anything that came through the gateway) ---
registerDeviceAdmin(app, mobilePort);

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

migrateToInstances((m) => app.log.info(m));
seedSkills();
startRoutines();
// Push notifications to paired phones (push.ts); wired to "needs you" items below.
startPush({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) });
startProgress();
startAttention();
wirePush(onAttention); // new "needs you" items notify paired phones
// Loopback only: Lima forwards 127.0.0.1-bound guest ports to the Mac, and nothing else in the VM
// (e.g. a tailnet interface) should reach the portal.
await app.listen({ host: "127.0.0.1", port });
await startMobileGateway(app, mobilePort);
