import type { FastifyInstance } from "fastify";
import { dmThreadOf, getAgent, spawnInstance } from "./agents.ts";
import { sendMessage } from "./runner.ts";
import {
  allMappings, cachedIntegrations, integrationStatus, jobOf, listIntegrations, mappedIntegrations, outputOf, rolesFor,
  setIntegrationRoles, setRoleIntegrations, ID_RE,
} from "./integrations.ts";
import { approve, getApproval, listApprovals, reject } from "./approvals.ts";
import { postIntegrationCard, setOwnerNotes, setupRole, setupTaskFor } from "./setup.ts";
import { sudoActive } from "./sudo.ts";
import { LOCAL_TOKEN_HEADER } from "./access.ts";

/**
 * Portal routes for integrations, the setup agent and approvals (docs/V2-ARCHITECTURE.md §10.3–10.5).
 * All under /api, so behind the portal's auth (access.ts). None are on the phone gateway's allowlist.
 */

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const wrap = <T>(fn: () => T): T => {
  try { return fn(); } catch (e: any) { throw e.statusCode ? e : httpError(400, e.message); }
};

export function registerIntegrationRoutes(app: FastifyInstance) {
  // The catalog, grouped by the UI. When the CLI isn't available the page says so.
  app.get("/api/integrations", async () => {
    let list = cachedIntegrations() ?? [];
    let error: string | null = null;
    // Checks run in the CLI (a second or two): reuse a very fresh catalog; actions invalidate it.
    try { list = await listIntegrations({ maxAgeMs: 10_000 }); } catch (e: any) { error = e.message; }
    const maps = allMappings();
    return {
      integrations: list.map((it) => ({ ...it, roles: maps.filter((m) => m.integration_id === it.id).map((m) => m.role_id) })),
      setup_role_id: setupRole()?.id ?? null,
      error,
    };
  });

  app.get("/api/integrations/:id", async (req) => {
    const id = (req.params as any).id;
    if (!ID_RE.test(id)) throw httpError(404, "No such integration");
    try {
      const it = await integrationStatus(id);
      // job: the last (or running) connect / verify / disconnect, for the card's live progress;
      // now: the server's clock, so the page's elapsed time doesn't depend on the browser's.
      const job = jobOf(id);
      return { ...it, roles: rolesFor(id), output: outputOf(id).slice(-40), job: job ? { ...job, lines: undefined } : null, now: new Date().toISOString() };
    } catch (e: any) {
      throw httpError(502, e.message);
    }
  });

  // The owner edits mappings directly (they're the editor); the setup agent only proposes.
  app.put("/api/integrations/:id/roles", async (req) => {
    const roles = (req.body as any)?.roles;
    if (!Array.isArray(roles)) throw httpError(400, "roles must be a list of agent ids");
    return { roles: wrap(() => setIntegrationRoles((req.params as any).id, roles.map(String))) };
  });
  app.get("/api/agents/:id/integrations", async (req) => ({ integrations: mappedIntegrations((req.params as any).id) }));
  app.put("/api/agents/:id/integrations", async (req) => {
    const ids = (req.body as any)?.integrations;
    if (!Array.isArray(ids)) throw httpError(400, "integrations must be a list of ids");
    return { integrations: wrap(() => setRoleIntegrations((req.params as any).id, ids.map(String))) };
  });

  // Connect / Reconnect / Disconnect: open (or create) the setup agent's task for it.
  app.post("/api/integrations/:id/task", async (req) => {
    const id = (req.params as any).id;
    const action = String((req.body as any)?.action ?? "connect");
    if (!["connect", "reconnect", "disconnect"].includes(action)) throw httpError(400, "action is connect, reconnect or disconnect");
    if (!ID_RE.test(id)) throw httpError(404, "No such integration");
    let title = id;
    try { title = (await listIntegrations({ maxAgeMs: 300_000 })).find((x) => x.id === id)?.title ?? id; } catch { /* the id will do */ }
    const r = wrap(() => setupTaskFor(action as any, { id, title }, {
      spawn: (roleId, label) => spawnInstance(roleId, { label, createdBy: "owner" }),
      send: (instanceId, text) => { sendMessage(instanceId, dmThreadOf(instanceId)!, text); },
      card: (instanceId) => postIntegrationCard(dmThreadOf(instanceId)!, id),
    }));
    return { instance_id: r.instance.id, created: r.created };
  });

  // Built-in roles: the owner's notes (their CLAUDE.md belongs to agentbox).
  app.put("/api/agents/:id/notes", async (req) => {
    const text = (req.body as any)?.text;
    if (typeof text !== "string") throw httpError(400, "text must be a string");
    const a = wrap(() => setOwnerNotes((req.params as any).id, text));
    return { owner_notes: a.owner_notes ?? "" };
  });

  // Approval cards. Applying one is the owner's click in the portal, never a CLI or agent call.
  app.get("/api/approvals", async (req) => {
    const q = req.query as any;
    return { approvals: listApprovals({ threadId: q.thread ? String(q.thread) : undefined, status: q.status ? String(q.status) : undefined }) };
  });
  app.get("/api/approvals/:id", async (req) => {
    const a = getApproval((req.params as any).id);
    if (!a) throw httpError(404, "No such approval");
    return { ...a, proposed_by_name: getAgent(a.proposed_by)?.name ?? null };
  });
  const ownerOnly = (req: any) => {
    if (req.headers[LOCAL_TOKEN_HEADER]) throw httpError(403, "Approvals are made by the owner in the portal");
  };
  app.post("/api/approvals/:id/approve", async (req) => {
    ownerOnly(req);
    return wrap(() => approve((req.params as any).id));
  });
  app.post("/api/approvals/:id/reject", async (req) => {
    ownerOnly(req);
    return wrap(() => reject((req.params as any).id));
  });

  // For the root helper that grants the setup agent's temporary sudo (server/setup-agent/agentbox-setup-sudo).
  app.get("/api/setup/sudo", async () => ({ active: sudoActive() }));
}
