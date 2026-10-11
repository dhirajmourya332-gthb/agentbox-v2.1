import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { all } from "./db.ts";
import { dmThreadOf, getAgent } from "./agents.ts";
import { enqueueTask } from "./runner.ts";
import { integrationStatus } from "./integrations.ts";
import { isSetupAgent, setupRole } from "./setup.ts";
import { createPlanChecker, planChecker, planView, setPlanChecker, type CheckerDeps } from "./setupPlan.ts";
import { createOwnerTerminal, ownerTerminal, setOwnerTerminal, type OwnerTerminal } from "./terminal.ts";
import { LOCAL_TOKEN_HEADER } from "./access.ts";

/**
 * The Setup workspace's server side (docs/V2-ARCHITECTURE.md › Changes (setup workspace)): the
 * owner's terminal (a node-pty shell the setup agent can read but never type into), the checklist's
 * checker, and their routes. Everything is under /api, behind the portal's auth (access.ts); none of it
 * is on the phone gateway's allowlist.
 */

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Tell the setup agent about checklist progress: a short note in its thread, as a queued turn. */
export function nudgeSetupAgent(instanceId: string, display: string, prompt: string) {
  const inst = getAgent(instanceId);
  if (!inst || inst.retired_at || !isSetupAgent(inst)) return;
  const thread = dmThreadOf(instanceId);
  if (!thread) return;
  enqueueTask({ agentId: instanceId, threadId: thread, source: "setup", title: "Checklist update", prompt, input: { author: "system", content: display } });
}

/** An integration step's state through the CLI (or the whole integration's, with no step). */
export async function integrationStepCheck(id: string, step: string | null) {
  const it = await integrationStatus(id);
  if (!step) return { ok: it.state === "connected", output: `${it.title}: ${it.state}${it.gates.length ? ` · waiting for: ${it.gates.map((g) => g.title).join("; ")}` : ""}` };
  const s = it.steps.find((x) => x.id === step);
  if (!s) return { ok: false, output: `${it.title} has no step "${step}"` };
  const ok = s.state === "done" || s.state === "skipped";
  return { ok, output: ok ? `${s.title}: ${s.state}` : (s.check?.timed_out ? "the check timed out" : s.check?.output ?? `${s.title}: ${s.state}`) };
}

/** Start the owner's terminal and the checker (index.ts). Tests pass their own pieces. */
export function startSetupWorkspace(opts: { terminal?: OwnerTerminal; checker?: Partial<CheckerDeps>; log?: (m: string) => void } = {}) {
  const term = opts.terminal ?? createOwnerTerminal({ log: opts.log });
  setOwnerTerminal(term);
  const checker = createPlanChecker({ nudge: nudgeSetupAgent, integrationCheck: integrationStepCheck, ...opts.checker });
  setPlanChecker(checker);
  checker.start();
  return { term, checker, stop: () => { checker.stop(); term.close(); setOwnerTerminal(null); setPlanChecker(null); } };
}

/** Only the owner's browser: never a local tool with the local token (agents run on this computer). */
function ownerOnly(req: FastifyRequest) {
  if (req.headers[LOCAL_TOKEN_HEADER] !== undefined) throw httpError(403, "The setup workspace is the owner's, in the portal");
}

/** The terminal's WebSocket, before the upgrade: the portal's auth, a browser Origin, no local token. */
export async function terminalGate(req: FastifyRequest, reply: FastifyReply) {
  if (req.headers[LOCAL_TOKEN_HEADER] !== undefined) return reply.code(403).send({ error: "The terminal is the owner's: local tools can't attach" });
  if (!req.portalAuth?.ok) return reply.code(403).send({ error: "Not allowed" });
  // Browsers always send Origin on a WebSocket; the portal's guard has checked it's ours.
  if (typeof req.headers.origin !== "string" || !req.headers.origin) return reply.code(403).send({ error: "Open the terminal from the portal" });
}

const mustSession = (id: string) => {
  const a = getAgent(id);
  if (!a || !a.base_agent_id || !isSetupAgent(a)) throw httpError(404, "No such setup session");
  return a;
};

export function registerSetupRoutes(app: FastifyInstance) {
  // Setup sessions (the setup agent's tasks): live first, then recently finished.
  app.get("/api/setup/sessions", async () => {
    const role = setupRole();
    if (!role) return { setup_role_id: null, sessions: [] };
    const rows = all<{ id: string; label: string | null; name: string; retired_at: string | null; created_at: string }>(
      `SELECT id, label, name, retired_at, created_at FROM agents WHERE base_agent_id = ? ORDER BY retired_at IS NOT NULL, created_at DESC LIMIT 30`, role.id,
    );
    return {
      setup_role_id: role.id,
      sessions: rows.map((r) => {
        const p = planView(r.id);
        return { ...r, plan: p ? { title: p.title, done: p.done_count, total: p.total, current: p.current } : null };
      }),
    };
  });

  app.get("/api/setup/plans/:id", async (req) => {
    const a = mustSession((req.params as any).id);
    return { plan: planView(a.id) };
  });

  // The owner's step buttons: Check now, Skip, Mark done, Reopen.
  app.post("/api/setup/plans/:id/steps/:step", async (req) => {
    ownerOnly(req);
    const a = mustSession((req.params as any).id);
    const action = String((req.body as any)?.action ?? "");
    const c = planChecker();
    if (!c) throw httpError(503, "The checker isn't running");
    try {
      const result = await c.ownerAction(a.id, String((req.params as any).step), action);
      return { plan: planView(a.id), result };
    } catch (e: any) {
      throw httpError(e.statusCode ?? 400, e.message);
    }
  });

  app.get("/api/setup/terminal/info", async () => {
    const t = ownerTerminal();
    if (!t) return { available: false, error: "The terminal isn't running" };
    const a = await t.available();
    return { available: a.ok, error: a.error };
  });

  app.get("/api/setup/terminal", { websocket: true, preValidation: terminalGate } as any, (socket: any) => {
    const t = ownerTerminal();
    if (!t) return socket.close(1011, "no terminal");
    t.attach(socket);
  });
}
