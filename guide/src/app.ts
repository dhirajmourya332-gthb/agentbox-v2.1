import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type WebSocket from "ws";
import { parse } from "yaml";
import { loadModules, planProfile, REQUIRED, type ModuleDef } from "./manifest.ts";
import { checksToRun, computeRoadmap, gatesTurnedGreen, modulesInCommand, stepKey, type Attempt, type Roadmap } from "./roadmap.ts";
import { CheckRunner, shellRunner, type RunCommand } from "./checks.ts";
import { createGuideAuth, type GuideAuth } from "./auth.ts";
import { createTerminal } from "./terminal.ts";
import { createSetupAgent, systemPrompt, RESUME_PROMPT, type AgentStatus, type LogEntry, type QueryFn, type Usage } from "./agent.ts";
import { addOutput, jobView, newJob, type Job } from "./progress.ts";

/**
 * The setup guide (docs/V2-ARCHITECTURE.md § 8, docs/GUIDE.md): roadmap state from the module
 * manifests and live checks, a terminal, the setup agent, the profile, the self-test and Finish.
 */

export const PROFILE_STEP = "guide.profile";
export const CLAUDE_LOGIN = stepKey("claude", "login");

export type GuideOptions = {
  configFile: string;
  /** The repo (setup/modules). Default: paths.src from the config. */
  src?: string;
  /** Where the guide keeps its state, tokens and the proxy secret. Default: <paths.data>/guide. */
  stateDir?: string;
  /** The built page (guide/dist). */
  webDist?: string;
  /** Runs check commands. Default: bash -lc as the agent user. */
  runCheck?: RunCommand;
  /** Runs privileged agentbox commands (config set, module install/disable, selftest). */
  runAdmin?: (args: string[], onOutput?: (chunk: string) => void) => Promise<{ code: number | null; output: string }>;
  /** The Agent SDK's query(). Default: imported lazily from @anthropic-ai/claude-agent-sdk. */
  query?: QueryFn;
  /** Called by Finish after everything is revoked (default: stop the systemd unit). */
  onFinish?: () => void;
  checkIntervalMs?: number;
  checkConcurrency?: number;
  checkTimeoutMs?: number;
  /** How often the per-module progress logs of the agent's installs are read (ms). */
  tailIntervalMs?: number;
  logger?: boolean;
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s: string) => s.replace(ANSI, "");
const tailLines = (s: string, n: number) => strip(s).trimEnd().split("\n").slice(-n).join("\n");

function readConfig(file: string): any {
  try { return parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; }
}

/** `sudo -n agentbox <args>`: as root without a password prompt (the guide's sudo grant during setup). */
export function sudoAgentbox(configFile: string): NonNullable<GuideOptions["runAdmin"]> {
  return (args, onOutput) => new Promise((resolve) => {
    const isRoot = process.getuid?.() === 0;
    const [file, argv] = isRoot ? ["agentbox", args] : ["sudo", ["-n", "env", `AGENTBOX_CONFIG=${configFile}`, "agentbox", ...args]];
    const child = spawn(file, argv, { env: { ...process.env, AGENTBOX_CONFIG: configFile }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (s: string) => { out += s; if (out.length > 512 * 1024) out = out.slice(-256 * 1024); onOutput?.(s); };
    child.stdout.setEncoding("utf8"); // whole characters only (⏳ is three bytes)
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => resolve({ code: 127, output: out + e.message }));
    child.on("close", (code) => resolve({ code, output: out }));
  });
}

type Persisted = {
  sessionId: string | null;
  /** "running" here after a stop means a turn was cut off: the next start resumes it. */
  agentStatus: AgentStatus;
  /** When the guide last resumed a cut-off turn (the agent pane says so). */
  resumedAt?: number | null;
  attempts: Record<string, Attempt>;
  log: LogEntry[];
  selftest: { ok: boolean; output: string; at: number } | null;
  finishedAt: number | null;
};

export async function createGuide(opts: GuideOptions) {
  let conf = readConfig(opts.configFile);
  let confStamp = "";
  const user = String(conf.user ?? os.userInfo().username);
  const src = opts.src ?? process.env.AGENTBOX_SRC ?? conf.paths?.src ?? path.resolve(import.meta.dirname, "../..");
  const stateDir = opts.stateDir ?? path.join(conf.paths?.data ?? "/opt/agentbox/data", "guide");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, "state.json");
  const markerFile = path.join(stateDir, "profile-confirmed");
  const problems: string[] = [];

  let modules: ModuleDef[] = [];
  const reloadModules = () => {
    const errs: string[] = [];
    modules = loadModules(src, (m) => errs.push(m));
    problems.splice(0, problems.length, ...errs);
  };
  reloadModules();

  // --- persisted state ----------------------------------------------------------------------------
  let st: Persisted = { sessionId: null, agentStatus: "idle", attempts: {}, log: [], selftest: null, finishedAt: null };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch { /* first run */ }
  // An attempt that was running when the guide stopped didn't finish.
  for (const a of Object.values(st.attempts)) if (a.status === "running") { a.status = "failed"; a.error = "interrupted (the guide restarted)"; }
  st.finishedAt = null; // a new run of the guide (e.g. to add a module later)
  // The setup agent was in the middle of a turn when the guide stopped: resume it once the checks are in.
  let resumePending = st.agentStatus === "running" && !!st.sessionId;
  if (st.agentStatus === "running" && !st.sessionId) st.agentStatus = "idle";
  let stopping = false;
  let saveTimer: NodeJS.Timeout | null = null;
  const writeState = () => {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };
  const save = () => {
    if (saveTimer || stopping) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeState(); }, 500);
  };

  // --- the auth -----------------------------------------------------------------------------------
  const auth: GuideAuth = createGuideAuth({
    tokensDir: path.join(stateDir, "tokens"), proxyTokenFile: path.join(stateDir, "proxy-token"), sessionsFile: path.join(stateDir, "sessions.json"),
  });
  auth.enableProxy();

  // --- checks -------------------------------------------------------------------------------------
  const env = { ...process.env, AGENTBOX_CONFIG: opts.configFile };
  const runner = new CheckRunner({
    run: opts.runCheck ?? shellRunner(user, env),
    intervalMs: opts.checkIntervalMs ?? 3000,
    concurrency: opts.checkConcurrency ?? 4,
    timeoutMs: opts.checkTimeoutMs ?? 10_000,
  });
  const specs = () => [
    { key: PROFILE_STEP, check: `test -f '${markerFile.replace(/'/g, "'\\''")}'` },
    ...checksToRun(modules, conf),
  ];
  runner.setSpecs(specs());

  // --- live state -----------------------------------------------------------------------------------
  const active = new Map<string, number>(); // module → running agent commands
  let usage: Usage = {};
  let roadmap: Roadmap | null = null;
  let selftestRunning = false;
  const stateClients = new Set<WebSocket>();
  const send = (msg: unknown) => { const s = JSON.stringify(msg); for (const c of stateClients) if (c.readyState === 1) c.send(s); };

  // --- live progress (guide/src/progress.ts) ------------------------------------------------------------
  const jobs = new Map<string, Job>(); // module → its running install / verify
  type Tail = { file: string; ino: number | null; offset: number; fresh: boolean; dec: StringDecoder };
  const tails = new Map<string, Tail>(); // module → the CLI's progress log of an agent-run install
  const runsDir = path.join(stateDir, "runs");
  let agentTool: { command: string; startedAt: number } | null = null;
  let agentActivityAt = 0;
  const progress = () => ({
    now: Date.now(),
    jobs: [...jobs.values()].map(jobView),
    agent: { tool: agentTool, lastActivityAt: agentActivityAt, resumedAt: st.resumedAt ?? null },
  });
  let progressTimer: NodeJS.Timeout | null = null;
  const pushProgress = () => {
    if (progressTimer) return;
    progressTimer = setTimeout(() => { progressTimer = null; send({ type: "progress", ...progress() }); }, 250);
  };
  function startJob(module: string, what: string, by: Job["by"]) {
    jobs.set(module, newJob(module, what, by, Date.now()));
    if (by === "agent" && what !== "verify") {
      const file = path.join(runsDir, `${module}.log`);
      let ino: number | null = null;
      try { ino = fs.statSync(file).ino; } catch { /* none yet */ }
      tails.set(module, { file, ino, offset: 0, fresh: false, dec: new StringDecoder("utf8") });
    }
    pushProgress();
  }
  function jobOutput(module: string, chunk: string) {
    const j = jobs.get(module);
    if (!j) return;
    addOutput(j, chunk, Date.now());
    pushProgress();
  }
  function endJob(module: string) {
    readTail(module);
    tails.delete(module);
    jobs.delete(module);
    pushProgress();
  }
  /** New output in the CLI's per-module log (a fresh file per run: a new inode, or written since the job started). */
  function readTail(module: string) {
    const t = tails.get(module), j = jobs.get(module);
    if (!t || !j) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(t.file); } catch { return; }
    if (!t.fresh) {
      if (stat.ino === t.ino && stat.mtimeMs < j.startedAt - 1000) return; // still the previous run's log
      t.fresh = true; t.offset = 0; t.ino = stat.ino;
    } else if (stat.ino !== t.ino) { t.ino = stat.ino; t.offset = 0; }
    if (stat.size < t.offset) t.offset = 0;
    if (stat.size === t.offset) return;
    const len = Math.min(stat.size - t.offset, 256 * 1024);
    const buf = Buffer.alloc(len);
    let fd: number | null = null;
    try {
      fd = fs.openSync(t.file, "r");
      const n = fs.readSync(fd, buf, 0, len, t.offset);
      t.offset += n;
      if (n > 0) jobOutput(module, t.dec.write(buf.subarray(0, n)));
    } catch { /* gone */ } finally { if (fd !== null) fs.closeSync(fd); }
  }
  const tailTimer = setInterval(() => { for (const id of tails.keys()) readTail(id); }, opts.tailIntervalMs ?? 1000);
  tailTimer.unref();

  const attempts = () => new Map(Object.entries(st.attempts));
  const profileDone = () => !!runner.results.get(PROFILE_STEP)?.ok;
  const claudeReady = () => !!runner.results.get(CLAUDE_LOGIN)?.ok;

  function portalUrl() {
    if (conf.access === "tailscale" && conf.tailscale?.hostname) return `https://${conf.tailscale.hostname}/`;
    if (conf.access === "cloudflare" && conf.cloudflare?.hostname) return `https://${conf.cloudflare.hostname}/`;
    return null;
  }

  function snapshot() {
    roadmap = computeRoadmap({ modules, config: conf, checks: runner.results, attempts: attempts(), active: new Set(active.keys()) });
    const r = runner.results.get(PROFILE_STEP);
    return {
      type: "state",
      host: { kind: conf.host ?? "?", name: os.hostname(), access: conf.access ?? "?", user },
      ports: { portal: conf.ports?.portal ?? 7700, guide: conf.ports?.guide ?? 7699 },
      portalUrl: portalUrl(),
      usage,
      problems,
      profile: {
        done: !!r?.ok,
        checked: !!r,
        required: REQUIRED,
        modules: Object.fromEntries(modules.filter((m) => !REQUIRED.includes(m.id)).map((m) => [m.id, conf.modules?.[m.id] === true])),
      },
      claudeReady: claudeReady(),
      agent: { status: agent.status, hasSession: !!st.sessionId, resumePending },
      progress: progress(),
      roadmap,
      selftest: st.selftest ? { ...st.selftest, running: selftestRunning } : { running: selftestRunning },
      finished: !!st.finishedAt,
      settled: runner.settled,
    };
  }
  let pushTimer: NodeJS.Timeout | null = null;
  let prevSettled = false;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      // Gates count as "turned green" only between two snapshots taken after a full pass of checks
      // (on start every gate looks open until its first check comes back).
      const before = prevSettled ? roadmap : null;
      const snap = snapshot();
      prevSettled = runner.settled;
      send(snap);
      // A human gate turned green: the agent continues on its own (unless paused).
      for (const g of gatesTurnedGreen(before, snap.roadmap)) {
        addLog("info", `✔ ${g.title}`);
        void agent.gateGreen(g.title);
      }
      if (!snap.roadmap.nextHuman && runner.settled) agent.gatesClosed();
      if (resumePending && runner.settled) void resumeAfterRestart();
      if (!snap.roadmap.allDone && st.selftest && runner.settled) { st.selftest = null; save(); }
      if (snap.roadmap.allDone && profileDone() && !st.selftest && !selftestRunning && runner.settled) void runSelftest();
    }, 100);
  };

  function addLog(kind: LogEntry["kind"], text: string, entry?: LogEntry) {
    const e = entry ?? { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), at: Date.now(), kind, text };
    st.log.push(e);
    if (st.log.length > 400) st.log.splice(0, st.log.length - 400);
    save();
    send({ type: "log", entry: e });
  }

  runner.onResult((_key, _r, changed) => { if (changed) push(); });

  // Config and manifests change underneath us (the owner runs `agentbox config set …` in the terminal).
  const watchConfig = () => {
    let stamp = "";
    try { const s = fs.statSync(opts.configFile); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* missing */ }
    if (stamp === confStamp) return;
    confStamp = stamp;
    conf = readConfig(opts.configFile);
    reloadModules();
    runner.setSpecs(specs());
    runner.recheck();
    push();
  };
  watchConfig();
  const confTimer = setInterval(watchConfig, 1000);
  const modTimer = setInterval(() => { reloadModules(); runner.setSpecs(specs()); }, 15_000);
  confTimer.unref(); modTimer.unref();

  // --- the setup agent ----------------------------------------------------------------------------
  const loadQuery = async (): Promise<QueryFn> => {
    if (opts.query) return opts.query;
    const sdk: any = await import("@anthropic-ai/claude-agent-sdk");
    return sdk.query as QueryFn;
  };
  let queryFn: QueryFn | null = opts.query ?? null;
  const agent = createSetupAgent({
    query: (args) => {
      if (!queryFn) throw new Error("the Agent SDK isn't loaded");
      return queryFn(args);
    },
    cwd: os.homedir(),
    env: { ...env, AGENTBOX_SETUP_AGENT: "1" },
    prompt: () => systemPrompt(modules, roadmap?.profile.order ?? [], conf),
    loadSession: () => st.sessionId,
    saveSession: (id) => { st.sessionId = id; save(); },
    onLog: (e) => addLog(e.kind, e.text, e),
    onStatus: (s) => {
      if (stopping) return; // the shutdown has recorded what the agent was doing
      st.agentStatus = s;
      if (s !== "running") agentTool = null;
      save(); push(); pushProgress();
    },
    onActivity: () => { agentActivityAt = Date.now(); },
    onTurnEnd: (how) => {
      lastTurnEnd = { how, at: Date.now() };
      if (!stopping && st.resumedAt) { st.resumedAt = null; save(); }
    },
    onUsage: (u) => { usage = { ...usage, ...u }; push(); },
    gateOpen: () => !!snapshot().roadmap.nextHuman,
    onTool: (ev) => {
      if (stopping) return;
      agentTool = ev.phase === "start" ? { command: ev.command, startedAt: Date.now() } : null;
      agentActivityAt = Date.now();
      pushProgress();
      const hit = modulesInCommand(ev.command, roadmap?.profile.order ?? modules.map((m) => m.id));
      if (!hit) return;
      for (const id of hit.ids) {
        if (ev.phase === "start") {
          active.set(id, (active.get(id) ?? 0) + 1);
          st.attempts[id] = { status: "running", what: hit.verb, at: Date.now() };
          if (!jobs.has(id)) startJob(id, hit.verb, "agent");
        } else {
          const n = (active.get(id) ?? 1) - 1;
          if (n <= 0) { active.delete(id); if (jobs.get(id)?.by === "agent") endJob(id); } else active.set(id, n);
          st.attempts[id] = ev.isError
            ? { status: "failed", what: hit.verb, at: Date.now(), error: tailLines(ev.output ?? "", 15) }
            : { status: "ok", what: hit.verb, at: Date.now() };
        }
      }
      save();
      if (ev.phase === "end") runner.recheck(roadmap?.modules.filter((m) => hit.ids.includes(m.id)).flatMap((m) => m.steps.map((s) => s.key)));
      push();
    },
  });
  agent.restoreStatus(st.agentStatus);
  let lastTurnEnd: { how: "finished" | "error" | "paused"; at: number } | null = null;

  /** The guide restarted in the middle of a turn: continue the saved session (once the checks are in). */
  async function resumeAfterRestart() {
    if (!resumePending) return;
    resumePending = false;
    if (agent.status !== "idle") return;
    if (!claudeReady() || !profileDone()) {
      st.agentStatus = "idle"; save();
      addLog("info", "The setup agent was working when the guide restarted. It continues when you press Continue (after the Claude login and the profile are green).");
      return;
    }
    st.resumedAt = Date.now();
    addLog("info", "↻ Resumed after a restart: the guide restarted while the setup agent was working; it continues where it left off.");
    const r = await startAgent(RESUME_PROMPT);
    if (!r.ok) { st.resumedAt = null; addLog("error", `couldn't resume the setup agent: ${r.error}`); }
    save(); push(); pushProgress();
  }

  async function startAgent(prompt?: string) {
    if (!claudeReady()) return { ok: false, code: 409, error: "Log in to Claude first (the claude login step must be green)." };
    if (!profileDone()) return { ok: false, code: 409, error: "Choose your modules first." };
    if (agent.status === "running") return { ok: false, code: 409, error: "The setup agent is already working." };
    try { queryFn = await loadQuery(); } catch (e: any) { return { ok: false, code: 500, error: `The Agent SDK can't load: ${e.message}` }; }
    void (agent.status === "paused" ? agent.resume(prompt) : agent.start(prompt));
    return { ok: true };
  }

  // --- admin actions --------------------------------------------------------------------------------
  const runAdmin = opts.runAdmin ?? sudoAgentbox(opts.configFile);
  const retrying = new Set<string>();

  async function retry(id: string) {
    if (!modules.some((m) => m.id === id)) return { ok: false, code: 404, error: "no such module" };
    if (retrying.has(id) || active.has(id)) return { ok: false, code: 409, error: "already running" };
    retrying.add(id);
    active.set(id, 1);
    st.attempts[id] = { status: "running", what: "install", at: Date.now() };
    addLog("info", `Retry: sudo agentbox module install ${id}`);
    startJob(id, "install", "retry");
    push();
    void runAdmin(["module", "install", id], (chunk) => jobOutput(id, chunk)).then((r) => {
      retrying.delete(id);
      active.delete(id);
      endJob(id);
      st.attempts[id] = r.code === 0
        ? { status: "ok", what: "install", at: Date.now() }
        : { status: "failed", what: "install", at: Date.now(), error: tailLines(r.output, 15) || `exit ${r.code}` };
      addLog(r.code === 0 ? "output" : "error", tailLines(r.output, 12) || `exit ${r.code}`);
      runner.recheck();
      push();
    });
    return { ok: true };
  }

  async function saveProfile(wanted: Record<string, boolean>) {
    const plan = planProfile(modules, conf, wanted);
    const out: string[] = [];
    for (const c of plan.changes) {
      // Turning a module off removes its units (module disable); on only records it: the setup
      // agent installs it in order.
      const args = c.on ? ["config", "set", `modules.${c.id}`, "true"] : ["module", "disable", c.id];
      const r = await runAdmin(args);
      out.push(`$ agentbox ${args.join(" ")}\n${strip(r.output).trim()}`);
      if (r.code !== 0) {
        addLog("error", out.join("\n"));
        watchConfig();
        return { ok: false, code: 500, error: `agentbox ${args.join(" ")} failed: ${tailLines(r.output, 4) || `exit ${r.code}`}. The guide needs passwordless sudo during setup (agentbox guide sets it up).` };
      }
    }
    fs.writeFileSync(markerFile, `${new Date().toISOString()}\n`, { mode: 0o600 });
    if (out.length) addLog("info", out.join("\n"));
    addLog("info", "profile saved");
    watchConfig();
    runner.recheck([PROFILE_STEP]);
    push();
    return { ok: true, changes: plan.changes };
  }

  async function runSelftest() {
    if (selftestRunning) return;
    selftestRunning = true;
    addLog("info", "Security self-test: sudo agentbox selftest");
    push();
    const r = await runAdmin(["selftest"]);
    selftestRunning = false;
    st.selftest = { ok: r.code === 0, output: strip(r.output).slice(-20_000), at: Date.now() };
    addLog(r.code === 0 ? "done" : "error", `self-test ${r.code === 0 ? "passed" : "FAILED"}`);
    save();
    push();
  }

  // --- HTTP -------------------------------------------------------------------------------------------
  const app: FastifyInstance = Fastify({ logger: opts.logger ?? false, disableRequestLogging: true, bodyLimit: 64 * 1024 });
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });
  const term = createTerminal({ env: { ...env }, log: (m) => app.log.warn(m) });

  const isApi = (p: string) => p.startsWith("/api/") || p.startsWith("/ws/");
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    const p = url.split("?")[0];
    if (p === "/healthz") return; // liveness only, for agentbox guide
    if (p !== decodeURIComponentSafe(p)) return reply.code(404).send();
    const token = p === "/" ? new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("t") ?? undefined : undefined;
    const d = auth.authorize({ method: req.method, headers: req.headers, remoteAddress: req.socket.remoteAddress }, { api: isApi(p), token: url.includes("?") ? token : undefined });
    reply.header("x-frame-options", "DENY");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    if (!d.ok) {
      if (!isApi(p) && req.method === "GET") return reply.code(d.code).type("text/html").send(refusedPage(d.error));
      return reply.code(d.code).send({ error: d.error });
    }
    if (d.setCookie) {
      // Token exchanged: drop it from the address bar.
      return reply.header("set-cookie", d.setCookie).redirect("./", 303);
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/state", async () => snapshot());
  app.get("/api/log", async () => ({ log: st.log }));
  app.post("/api/recheck", async () => { runner.recheck(); return { ok: true }; });
  app.post("/api/profile", async (req, reply) => {
    const body: any = req.body ?? {};
    const wanted = body.modules;
    if (!wanted || typeof wanted !== "object" || Array.isArray(wanted)) return reply.code(400).send({ error: "modules: {id: true|false}" });
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(wanted)) if (/^[a-z0-9-]+$/.test(k) && typeof v === "boolean") clean[k] = v;
    const r = await saveProfile(clean);
    return r.ok ? r : reply.code(r.code!).send({ error: r.error });
  });
  app.post("/api/retry", async (req, reply) => {
    const id = String((req.body as any)?.module ?? "");
    const r = await retry(id);
    return r.ok ? r : reply.code(r.code!).send({ error: r.error });
  });
  app.post("/api/agent/start", async (_req, reply) => {
    const r = await startAgent();
    return r.ok ? r : reply.code(r.code!).send({ error: r.error });
  });
  app.post("/api/agent/pause", async () => { await agent.pause(); return { ok: true }; });
  app.post("/api/agent/resume", async (_req, reply) => {
    const r = await startAgent("continue");
    return r.ok ? r : reply.code(r.code!).send({ error: r.error });
  });
  app.post("/api/selftest", async (_req, reply) => {
    if (!snapshot().roadmap.allDone) return reply.code(409).send({ error: "Every step must be done first." });
    void runSelftest();
    return { ok: true };
  });
  app.post("/api/finish", async (_req, reply) => {
    if (!st.selftest?.ok) return reply.code(409).send({ error: "The security self-test must pass first." });
    st.finishedAt = Date.now();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    fs.writeFileSync(stateFile, JSON.stringify(st), { mode: 0o600 });
    send({ type: "finished", portalUrl: portalUrl() });
    setTimeout(() => {
      auth.revokeAll();
      term.close();
      for (const c of stateClients) try { c.close(1001, "finished"); } catch { /* gone */ }
      (opts.onFinish ?? defaultFinish)();
    }, 200);
    return { ok: true, portalUrl: portalUrl() };
  });

  app.get("/ws/state", { websocket: true }, (socket) => {
    stateClients.add(socket);
    socket.send(JSON.stringify(snapshot()));
    socket.send(JSON.stringify({ type: "logs", log: st.log }));
    socket.on("close", () => stateClients.delete(socket));
  });
  app.get("/ws/term", { websocket: true }, (socket) => term.attach(socket));

  const dist = opts.webDist ?? path.resolve(import.meta.dirname, "../dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, index: ["index.html"], wildcard: true });
  } else {
    app.get("/", async (_req, reply) => reply.type("text/html").send("<p>The guide page isn't built (guide/install.sh builds it).</p>"));
  }

  runner.start();
  push();

  return {
    app, auth, runner, agent,
    snapshot,
    stateDir,
    /**
     * Stop (SIGTERM: a restart, `agentbox guide stop`, a redeploy). Records whether the setup agent
     * was mid-turn, so the next start resumes it, and keeps the sessions (sessions.json) so open
     * pages reconnect. Finish revokes everything; `agentbox guide stop` deletes the sessions file.
     */
    async close() {
      if (!stopping) {
        // A turn that ended in an error just now most likely died with us (its Claude Code process
        // was stopped first): count it as cut off too.
        const cutOff = agent.status === "running" || (lastTurnEnd?.how === "error" && Date.now() - lastTurnEnd.at < 5000);
        stopping = true;
        if (cutOff && !st.finishedAt) st.agentStatus = "running";
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        try { writeState(); } catch { /* read-only? nothing to keep */ }
      }
      runner.stop();
      clearInterval(confTimer);
      clearInterval(modTimer);
      clearInterval(tailTimer);
      if (progressTimer) clearTimeout(progressTimer);
      if (pushTimer) clearTimeout(pushTimer);
      term.close();
      auth.disableProxy();
      for (const c of stateClients) try { c.close(1012, "the guide is restarting"); } catch { /* gone */ }
      await app.close();
    },
  };
}

function decodeURIComponentSafe(p: string) { try { return decodeURIComponent(p); } catch { return ""; } }

function defaultFinish() {
  // The unit's ExecStopPost removes the sudo grant and any tokens; stop ourselves.
  const child = spawn("sudo", ["-n", "systemctl", "stop", "agentbox-guide"], { detached: true, stdio: "ignore" });
  child.on("error", () => process.exit(0));
  child.unref();
  setTimeout(() => process.exit(0), 5000).unref();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function refusedPage(msg: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>agentbox setup</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px;color:#16181D;background:#F7F7F8}
@media (prefers-color-scheme:dark){body{color:#E7E9EE;background:#0E0F12}}code{font:13px ui-monospace,Menlo,monospace}</style>
<h1 style="font-size:18px">agentbox setup guide</h1><p>${esc(msg).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
<p>Your setup progress is kept on the VM; the new link picks up where you left off.</p>`;
}
