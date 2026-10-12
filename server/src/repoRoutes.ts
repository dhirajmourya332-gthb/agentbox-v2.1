import { memoryOf } from "./memory.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LOCAL_TOKEN_HEADER } from "./access.ts";
import { GATEWAY_HEADER } from "./mobile.ts";
import { listAgents } from "./agents.ts";
import { createRoutine, defaultTimezone, listRoutines } from "./routines.ts";
import {
  RepoConflict, addRepo, archiveRepo, bindingsOf, checkAccess, cloneRepo, discardWorktree, fetchAll, fetchRepo, getRepo, getWorktree,
  listRepos, mapFiles, onboardingRole, purgeRepo, repoView, startOnboarding, sweep, updateRepo,
} from "./repos.ts";
import { accountRepos } from "./repoAccounts.ts";
import {
  failRequest, completeRequest, getRequest, listRequests, ownerRequest, rejectRequest, requestView, startRequest,
} from "./setupRequests.ts";

/**
 * Portal routes for repos and setup requests (docs/V2-ARCHITECTURE.md, Changes (repos)). All under
 * /api behind the portal's auth. The CLI (`agentbox repo …`, local token) can list, add, fetch,
 * re-map and archive; purging, discarding unpushed work and starting or deciding setup requests are
 * the owner's clicks only (refused with the local token).
 */

const httpError = (statusCode: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const wrap = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e: any) {
    if (e instanceof RepoConflict) throw httpError(409, e.message, { detail: e.detail });
    throw e.statusCode ? e : httpError(400, e.message);
  }
};
const ownerOnly = (req: FastifyRequest, what: string) => {
  if (req.headers[LOCAL_TOKEN_HEADER]) throw httpError(403, `${what} is the owner's click in the portal`);
};
const mustRepo = (name: string) => {
  const r = getRepo(name);
  if (!r) throw httpError(404, "No such repo");
  return r;
};

export const MAP_ROUTINE_NAME = "Refresh repo maps weekly";

export function registerRepoRoutes(app: FastifyInstance) {
  app.get("/api/repos", async () => {
    const routine = listRoutines().find((r) => r.name === MAP_ROUTINE_NAME);
    return { repos: listRepos().map((r) => ({ ...repoView(r), memory: r.status === "archived" ? null : memoryOf(r) })), map_routine: routine ? { id: routine.id, enabled: routine.enabled } : null };
  });
  app.get("/api/repos/available", async (req) => wrap(() => accountRepos({ refresh: (req.query as any)?.refresh === "1" })));
  app.post("/api/repos/check", async (req) => wrap(async () => {
    const url = String((req.body as any)?.url ?? "");
    const r = await checkAccess(url);
    return { ...r, taken: !!getRepo(r.name) };
  }));
  app.post("/api/repos", async (req) => wrap(() => repoView(addRepo(req.body as any))));
  app.get("/api/repos/:name", async (req) => repoView(mustRepo((req.params as any).name)));
  app.patch("/api/repos/:name", async (req) => wrap(() => repoView(updateRepo((req.params as any).name, req.body as any))));
  app.post("/api/repos/:name/fetch", async (req) => wrap(async () => repoView(await fetchRepo(mustRepo((req.params as any).name).name))));
  app.post("/api/repos/fetch-all", async () => ({ results: await fetchAll() }));
  app.post("/api/repos/:name/retry", async (req) => wrap(async () => {
    const r = mustRepo((req.params as any).name);
    if (r.status !== "error") throw new Error(`${r.name} is ${r.status}`);
    void cloneRepo(r.id).then((ok) => { if (ok && r.map_status === "none") { try { startOnboarding(r.name); } catch { /* shown on the card */ } } });
    return repoView(getRepo(r.name)!);
  }));
  app.post("/api/repos/:name/remap", async (req) => wrap(() => {
    const inst = startOnboarding(mustRepo((req.params as any).name).name);
    return { instance_id: inst.id };
  }));
  app.get("/api/repos/:name/map", async (req) => mapFiles(mustRepo((req.params as any).name).name));
  app.post("/api/repos/:name/archive", async (req) => wrap(async () => repoView(await archiveRepo((req.params as any).name, { confirmUnpushed: (req.body as any)?.confirm_unpushed === true }))));
  app.post("/api/repos/:name/purge", async (req) => {
    ownerOnly(req, "Purging a repo");
    return wrap(() => purgeRepo((req.params as any).name));
  });
  app.post("/api/repos/worktrees/:id/discard", async (req) => {
    ownerOnly(req, "Discarding unpushed work");
    if (!getWorktree((req.params as any).id)) throw httpError(404, "No such worktree");
    return wrap(() => discardWorktree((req.params as any).id));
  });
  app.post("/api/repos/sweep", async () => sweep());
  app.get("/api/agents/:id/repos", async (req) => ({ repos: bindingsOf((req.params as any).id) }));

  // The routine template: weekly map refresh, created paused (the owner enables it).
  app.post("/api/repos/map-routine", async () => wrap(() => {
    const existing = listRoutines().find((r) => r.name === MAP_ROUTINE_NAME);
    if (existing) return { id: existing.id, created: false };
    const ready = listRepos({ archived: false }).filter((r) => r.status === "ready");
    const role = (ready[0] && onboardingRole(ready[0])) ?? listAgents().find((a) => !a.base_agent_id && !a.builtin);
    if (!role) throw new Error("Create a tech-lead or coding agent first");
    const r = createRoutine({
      agent_id: role.id, name: MAP_ROUTINE_NAME, cron: "0 6 * * 1", timezone: defaultTimezone(), enabled: false,
      prompt: `Refresh the repo maps. For each repo in the Repos section of your instructions: call use_repo(name), compare its map (the folder named there) with the code at origin's default branch (git log since the map's date, new or moved entry points, commands that changed), and update the files that drifted with the onboard-repo skill. Re-run the test command. Then call repo_map_done for that repo. Report what changed per repo.`,
    }, "owner");
    return { id: r.id, created: true };
  }));

  // --- setup requests -------------------------------------------------------------------------
  app.get("/api/setup-requests", async (req) => {
    const q = req.query as any;
    return { requests: listRequests({ status: q.status ? String(q.status) : undefined, thread: q.thread ? String(q.thread) : undefined }).map(requestView) };
  });
  app.get("/api/setup-requests/:id", async (req) => {
    const r = getRequest((req.params as any).id);
    if (!r) throw httpError(404, "No such request");
    return requestView(r);
  });
  // The owner's own request (e.g. "Add repo" couldn't reach a URL): created and usually started at once.
  app.post("/api/setup-requests", async (req) => {
    ownerOnly(req, "Raising a setup request from the portal");
    return wrap(() => requestView(ownerRequest(req.body as any)));
  });
  app.post("/api/setup-requests/:id/start", async (req) => {
    ownerOnly(req, "Starting the setup agent");
    if (req.headers[GATEWAY_HEADER] !== undefined) {
      throw httpError(409, "Finish this on the web: the Setup workspace has your terminal for the logins.", { web_only: true });
    }
    return wrap(() => {
      const r = startRequest((req.params as any).id);
      return { instance_id: r.instance_id, created: r.created, request: requestView(r.request) };
    });
  });
  app.post("/api/setup-requests/:id/reject", async (req) => {
    ownerOnly(req, "Declining a setup request");
    return wrap(() => requestView(rejectRequest((req.params as any).id, String((req.body as any)?.reason ?? ""))));
  });
  app.post("/api/setup-requests/:id/mark", async (req) => {
    ownerOnly(req, "Marking a setup request");
    const b = req.body as any;
    const id = (req.params as any).id;
    if (b?.status === "done") return wrap(() => requestView(completeRequest(id, String(b?.note ?? "Marked done by the owner."))));
    if (b?.status === "failed") return wrap(() => requestView(failRequest(id, String(b?.note ?? ""))));
    throw httpError(400, "status is done or failed");
  });
}
