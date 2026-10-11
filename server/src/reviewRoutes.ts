import type { FastifyInstance, FastifyRequest } from "fastify";
import { LOCAL_TOKEN_HEADER } from "./access.ts";
import { getAgent, rootOf } from "./agents.ts";
import { getReview, reviewsOf, submitReview, taskChanges, treeWorktrees } from "./changes.ts";
import { decidePlan, gateState, getPlan, planView, plansOf, setGate, type Decision } from "./plans.ts";
import { archiveRoadmap, getRoadmap, roadmapView, workRoadmaps } from "./roadmaps.ts";

/**
 * Portal routes for plans, diff review and roadmaps (docs/V2.1-PLAN.md). Deciding a plan and
 * submitting a review are the owner's clicks (refused with the local token, so the CLI and agents
 * can't approve their own work); the phone may decide plans.
 */

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const wrap = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e: any) { throw e.statusCode ? e : httpError(400, e.message); }
};
const ownerOnly = (req: FastifyRequest, what: string) => {
  if (req.headers[LOCAL_TOKEN_HEADER]) throw httpError(403, `${what} is the owner's click in the portal`);
};
const mustTask = (id: string) => {
  const a = getAgent(id);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  return a;
};

export function registerReviewRoutes(app: FastifyInstance) {
  // Diff review
  app.get("/api/agents/:id/changes", async (req) => wrap(() => taskChanges(mustTask((req.params as any).id).id)));
  app.get("/api/agents/:id/changes/summary", async (req) => {
    const root = rootOf(mustTask((req.params as any).id));
    return { root_id: root.id, worktrees: treeWorktrees(root.id).filter((w) => w.status !== "removed").length };
  });
  app.get("/api/agents/:id/reviews", async (req) => reviewsOf(rootOf(mustTask((req.params as any).id)).id));
  app.get("/api/reviews/:id", async (req) => {
    const r = getReview((req.params as any).id);
    if (!r) throw httpError(404, "No such review");
    return r;
  });
  app.post("/api/agents/:id/review", async (req) => wrap(() => {
    ownerOnly(req, "Reviewing changes");
    return submitReview(mustTask((req.params as any).id).id, (req.body ?? {}) as any);
  }));

  // Roadmaps (agents write them; the owner reads, and may archive one)
  app.get("/api/agents/:id/roadmaps", async (req) => wrap(() => workRoadmaps(mustTask((req.params as any).id).id, { archived: (req.query as any)?.archived === "1" })));
  app.get("/api/roadmaps/:id", async (req) => {
    const r = getRoadmap((req.params as any).id);
    if (!r) throw httpError(404, "No such roadmap");
    return roadmapView(r);
  });
  app.post("/api/roadmaps/:id/archive", async (req) => wrap(() => {
    ownerOnly(req, "Archiving a roadmap");
    return roadmapView(archiveRoadmap((req.params as any).id, (req.body as any)?.archived !== false));
  }));

  // Plans
  app.get("/api/agents/:id/plans", async (req) => {
    const root = rootOf(mustTask((req.params as any).id));
    return { gate: gateState(root.id), plans: plansOf(root.id).map(planView) };
  });
  app.post("/api/agents/:id/plan-gate", async (req) => wrap(() => {
    ownerOnly(req, "Changing the plan gate");
    return setGate(mustTask((req.params as any).id).id, !!(req.body as any)?.required);
  }));
  app.get("/api/plans/:id", async (req) => {
    const p = getPlan((req.params as any).id);
    if (!p) throw httpError(404, "No such plan");
    return planView(p);
  });
  app.post("/api/plans/:id/decide", async (req) => wrap(() => {
    ownerOnly(req, "Deciding a plan");
    const b = (req.body ?? {}) as any;
    return planView(decidePlan((req.params as any).id, String(b.verdict) as Decision, b.note));
  }));
}
