import path from "node:path";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { dmThreadOf, getAgent, reviveInstance, rootOf, type Agent } from "./agents.ts";
import { enqueueTask } from "./runner.ts";
import { raiseAttention, markSeen } from "./attention.ts";
import { isSetupAgent } from "./setup.ts";
import { worktreesRoot } from "./repos.ts";

/**
 * Plans (docs/V2.1-PLAN.md §1): a short plan led by a before/after diagram (`submit_plan`). Nothing
 * makes agents plan, and by default nothing waits on the owner:
 * - Shared (the default): the agent shares a plan for a significant design change and carries on in
 *   the same turn. The owner may glance at it later and redirect or stop the work; no "needs you".
 * - Approve first (the task's plan gate, the owner's opt-in per task): the plan waits for the owner
 *   ("needs you"), and until one is approved, edits inside repo worktrees and git commits/pushes are
 *   refused. The agent is called back with the decision.
 * The diagram must stay simple: the server refuses plans that are too big or show parts that don't change.
 */

run(`CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,               -- the task (root instance) the plan is for
  instance_id TEXT NOT NULL,           -- who submitted it (called back with the decision)
  task_id TEXT,
  thread_id TEXT,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,                -- shared | pending | approved | changes | rejected | superseded
  title TEXT NOT NULL,
  body TEXT NOT NULL,                  -- the validated plan (JSON)
  feedback TEXT,
  attention_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
)`);
run(`CREATE INDEX IF NOT EXISTS plans_root ON plans(root_id, created_at)`);
run(`CREATE TABLE IF NOT EXISTS plan_gates (root_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);

export const LIMITS = {
  title: 80, summary: 280, label: 32, edgeLabel: 24, change: 60, item: 140, details: 8000,
  afterNodes: 10, beforeNodes: 10, allNodes: 14, edges: 14, changes: 6, checks: 5, risks: 3,
};

export type Node = { id: string; label: string; change?: string };
export type Edge = { from: string; to: string; label?: string };
export type Graph = { nodes: Node[]; edges: Edge[] };
export type PlanBody = {
  title: string; summary: string; diagram: { before: Graph; after: Graph };
  changes: string[]; checks: string[]; risks: string[]; details: string;
};
export type PlanStatus = "shared" | "pending" | "approved" | "changes" | "rejected" | "superseded";
export type Plan = {
  id: string; root_id: string; instance_id: string; task_id: string | null; thread_id: string | null; version: number;
  status: PlanStatus; title: string; body: PlanBody; feedback: string | null; attention_id: string | null; created_at: string; decided_at: string | null;
};

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const oneLine = (s: unknown) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
const block = (s: unknown, max: number) => String(s ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

function short(what: string, v: unknown, max: number, required = true): string {
  const s = oneLine(v);
  if (!s && required) throw new Error(`${what} is empty`);
  if (s.length > max) throw new Error(`${what} is ${s.length} characters; keep it to ${max} ("${s.slice(0, 40)}…")`);
  return s;
}

function list(what: string, v: unknown, max: number, min = 0): string[] {
  const items = (Array.isArray(v) ? v : v == null ? [] : [v]).map((x, i) => short(`${what}[${i + 1}]`, x, LIMITS.item)).filter(Boolean);
  if (items.length < min) throw new Error(`${what}: give at least ${min}`);
  if (items.length > max) throw new Error(`${what}: ${items.length} items; keep the ${max} that matter most`);
  return items;
}

function graph(which: "before" | "after", g: any): Graph {
  const nodes: Node[] = [];
  const seen = new Set<string>();
  for (const [i, n] of (Array.isArray(g?.nodes) ? g.nodes : []).entries()) {
    const id = String(n?.id ?? "").trim();
    if (!ID_RE.test(id)) throw new Error(`diagram.${which}.nodes[${i + 1}].id "${id}": use a short id (letters, digits, - _ .)`);
    if (seen.has(id)) throw new Error(`diagram.${which}: the id "${id}" is used twice`);
    seen.add(id);
    const label = short(`diagram.${which} box "${id}" label`, n?.label ?? id, LIMITS.label);
    const change = which === "after" && n?.change ? short(`diagram.after box "${id}" change`, n.change, LIMITS.change) : undefined;
    nodes.push(change ? { id, label, change } : { id, label });
  }
  const edges: Edge[] = [];
  const keys = new Set<string>();
  for (const [i, e] of (Array.isArray(g?.edges) ? g.edges : []).entries()) {
    const from = String(e?.from ?? "").trim(), to = String(e?.to ?? "").trim();
    if (!seen.has(from) || !seen.has(to)) throw new Error(`diagram.${which}.edges[${i + 1}] (${from} → ${to}): both ends must be boxes in diagram.${which}`);
    const key = `${from}\u0000${to}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const label = e?.label ? short(`diagram.${which} arrow ${from} → ${to} label`, e.label, LIMITS.edgeLabel) : undefined;
    edges.push(label ? { from, to, label } : { from, to });
  }
  return { nodes, edges };
}

/** Validate a plan, enforcing a diagram that's small and only about the change. */
export function validatePlan(input: any): PlanBody {
  const before = graph("before", input?.diagram?.before ?? { nodes: [], edges: [] });
  const after = graph("after", input?.diagram?.after);
  if (!after.nodes.length) throw new Error("diagram.after is empty: draw the components as they'll be after the change");
  if (after.nodes.length > LIMITS.afterNodes || before.nodes.length > LIMITS.beforeNodes) {
    throw new Error(`The diagram is too big (${before.nodes.length} boxes before, ${after.nodes.length} after; at most ${LIMITS.afterNodes} each). Show only the components that change and their direct neighbours, and merge details into one box.`);
  }
  const all = new Set([...before.nodes, ...after.nodes].map((n) => n.id));
  if (all.size > LIMITS.allNodes) throw new Error(`Before and after together have ${all.size} different boxes (at most ${LIMITS.allNodes}). Simplify: group related parts into one box.`);
  if (before.edges.length > LIMITS.edges || after.edges.length > LIMITS.edges) throw new Error(`Too many arrows (at most ${LIMITS.edges}). Keep only the flows that change and the ones they connect to.`);

  // What changes, and the boxes that touch it. Everything else is noise in this picture.
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const now_ = new Map(after.nodes.map((n) => [n.id, n]));
  const ek = (e: Edge) => `${e.from}\u0000${e.to}`;
  const oldE = new Set(before.edges.map(ek)), newE = new Set(after.edges.map(ek));
  const changedNodes = new Set<string>();
  for (const n of after.nodes) { const o = was.get(n.id); if (!o || n.change || o.label !== n.label) changedNodes.add(n.id); }
  for (const n of before.nodes) if (!now_.has(n.id)) changedNodes.add(n.id);
  const oldLabel = new Map(before.edges.map((e) => [ek(e), e.label ?? ""]));
  const changedEdges = [
    ...after.edges.filter((e) => !oldE.has(ek(e)) || oldLabel.get(ek(e)) !== (e.label ?? "")), // new, or what flows on it changed
    ...before.edges.filter((e) => !newE.has(ek(e))),
  ];
  if (before.nodes.length && !changedNodes.size && !changedEdges.length) {
    throw new Error("Before and after are the same picture. Mark what changes: a new box or arrow, a removed one, or `change` on a box that behaves differently (e.g. change: \"adds retries\").");
  }
  if (before.nodes.length) {
    const touching = new Set(changedNodes);
    for (const e of changedEdges) { touching.add(e.from); touching.add(e.to); }
    for (const e of [...before.edges, ...after.edges]) {
      if (changedNodes.has(e.from)) touching.add(e.to);
      if (changedNodes.has(e.to)) touching.add(e.from);
    }
    const bystanders = [...all].filter((id) => !touching.has(id)).map((id) => (now_.get(id) ?? was.get(id))!.label);
    if (bystanders.length) {
      throw new Error(`These boxes don't change and aren't connected to anything that does: ${bystanders.join(", ")}. Leave them out; the diagram should show only the change and its direct neighbours.`);
    }
  }
  return {
    title: short("title", input?.title, LIMITS.title),
    summary: short("summary", input?.summary, LIMITS.summary),
    diagram: { before, after },
    changes: list("changes", input?.changes, LIMITS.changes, 1),
    checks: list("checks", input?.checks, LIMITS.checks),
    risks: list("risks", input?.risks, LIMITS.risks),
    details: block(input?.details, LIMITS.details),
  };
}

// --- storage ------------------------------------------------------------------------------------------

const toPlan = (r: any): Plan => ({ ...r, body: JSON.parse(r.body) });
export const getPlan = (id: string) => { const r = get<any>(`SELECT * FROM plans WHERE id = ?`, id); return r ? toPlan(r) : null; };
export const plansOf = (rootId: string) => all<any>(`SELECT * FROM plans WHERE root_id = ? ORDER BY created_at DESC, version DESC LIMIT 50`, rootId).map(toPlan);
export const approvedPlan = (rootId: string) => {
  const r = get<any>(`SELECT * FROM plans WHERE root_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1`, rootId);
  return r ? toPlan(r) : null;
};
export const gateRequired = (rootId: string) => !!get(`SELECT 1 FROM plan_gates WHERE root_id = ?`, rootId);

export function setGate(rootId: string, required: boolean) {
  const a = getAgent(rootId);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  const root = rootOf(a);
  if (required) run(`INSERT OR IGNORE INTO plan_gates (root_id, created_at) VALUES (?, ?)`, root.id, now());
  else run(`DELETE FROM plan_gates WHERE root_id = ?`, root.id);
  publish({ type: "plan_gate.updated", rootId: root.id, required });
  return gateState(root.id);
}

export function gateState(rootId: string) {
  const plan = approvedPlan(rootId);
  return { required: gateRequired(rootId), approved: plan ? { id: plan.id, version: plan.version, title: plan.title } : null };
}

/** True while this agent's work needs an approved plan and has none. */
export function planBlocks(agent: Agent): boolean {
  if (!agent.base_agent_id) return false;
  const root = rootOf(agent);
  return gateRequired(root.id) && !approvedPlan(root.id);
}

export function planView(p: Plan) {
  const who = getAgent(p.instance_id);
  return { ...p, instance_name: who?.name ?? null };
}
function announce(id: string) {
  const p = getPlan(id)!;
  publish({ type: "plan.updated", plan: planView(p) });
  return p;
}

function postCard(threadId: string, id: string) {
  const message = { id: newId(), thread_id: threadId, author: "plan", task_id: null, content: id, created_at: now() };
  run(`INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at);
  publish({ type: "message.created", message });
}

/** `submit_plan`: a new version for this work (an older open one is replaced); waits only behind the gate. */
export function submitPlan(agent: Agent, taskId: string | null, input: any): Plan {
  if (isSetupAgent(agent)) throw new Error("The setup agent uses its checklist (set_plan), not submit_plan.");
  if (!agent.base_agent_id) throw new Error("Plans come from tasks (instances)");
  const body = validatePlan(input);
  const root = rootOf(agent);
  const threadId = (taskId ? get<{ thread_id: string }>(`SELECT thread_id FROM tasks WHERE id = ?`, taskId)?.thread_id : null) ?? dmThreadOf(agent.id);
  // It waits for the owner when the work is gated, or when the owner asked for a plan in so many words.
  const gated = (gateRequired(root.id) && !approvedPlan(root.id)) || input?.wait_for_owner === true;
  for (const old of all<any>(`SELECT * FROM plans WHERE root_id = ? AND status IN ('pending', 'shared')`, root.id)) {
    run(`UPDATE plans SET status = 'superseded', decided_at = ? WHERE id = ?`, now(), old.id);
    if (old.attention_id) markSeen(old.attention_id);
    announce(old.id);
  }
  const version = ((get<{ v: number | null }>(`SELECT MAX(version) AS v FROM plans WHERE root_id = ?`, root.id)?.v ?? 0) as number) + 1;
  const id = newId();
  run(`INSERT INTO plans (id, root_id, instance_id, task_id, thread_id, version, status, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, root.id, agent.id, taskId, threadId, version, gated ? "pending" : "shared", body.title, JSON.stringify(body), now());
  if (threadId) postCard(threadId, id);
  // Only a plan the work is waiting on needs the owner; a shared one is there to look at, not to answer.
  if (gated) {
    const item = raiseAttention("question", agent.id, taskId, root.created_by === "owner" ? root.id : null, `${agent.name} has a plan for you: ${body.title}`);
    run(`UPDATE plans SET attention_id = ? WHERE id = ?`, item.id, id);
  }
  return announce(id);
}

export type Decision = "approve" | "changes" | "reject";

export function decisionPrompt(p: Plan, verdict: Decision, note: string, shared = false) {
  const name = `"${p.title}" (v${p.version})`;
  if (shared) {
    // The agent didn't wait for this: it's a course correction to work already under way.
    if (verdict === "changes") {
      return `The owner looked at the plan you shared, ${name}, and wants a different approach: ${note}
Adjust your work to that: undo or stop what conflicts with it, then carry on. Don't wait for approval; share a revised plan only if the approach changes a lot.`;
    }
    return `The owner looked at the plan you shared, ${name}, and wants you to stop this approach${note ? `: ${note}` : "."}
Stop work that follows it (don't push, merge or deploy it), report where things stand, and wait for the owner.`;
  }
  if (verdict === "approve") {
    return `The owner approved your plan ${name}.${note ? ` Their note: ${note}` : ""}
Go ahead and carry it out: if it has several steps or teammates, start by creating its roadmap (roadmap_create), then do or delegate the work. If you later change direction in a way the diagram wouldn't show, share a revised plan (submit_plan) and carry on.`;
  }
  if (verdict === "changes") {
    return `The owner asks for changes to your plan ${name}: ${note || "(no details given; ask what to change)"}
Revise it and call \`mcp__team__submit_plan\` again (keep the diagram simple), then end your turn. Don't start implementing yet.`;
  }
  return `The owner rejected your plan ${name}${note ? `: ${note}` : "."}
Don't implement it. Report what you'd need to know or do differently, and wait for the owner.`;
}

export type DecideDeps = { send?: (a: Agent, p: Plan, content: string, prompt: string) => void };

/**
 * The owner's decision. On a plan the work waits for (pending), the submitter always gets a new turn.
 * On a shared one, "approve" just marks it looked at (the agent never waited); "changes" and "reject"
 * redirect or stop the work under way.
 */
export function decidePlan(id: string, verdict: Decision, noteIn: unknown, deps: DecideDeps = {}): Plan {
  const p = getPlan(id);
  if (!p) throw httpError(404, "No such plan");
  if (p.status !== "pending" && p.status !== "shared") throw httpError(409, `This plan is already ${p.status === "changes" ? "sent back for changes" : p.status}`);
  const shared = p.status === "shared";
  if (!["approve", "changes", "reject"].includes(verdict)) throw httpError(400, "verdict: approve, changes or reject");
  const note = block(noteIn, 4000);
  if (verdict === "changes" && !note) throw httpError(400, "Say what to change");
  const status: PlanStatus = verdict === "approve" ? "approved" : verdict === "changes" ? "changes" : "rejected";
  run(`UPDATE plans SET status = ?, feedback = ?, decided_at = ? WHERE id = ?`, status, note || null, now(), id);
  if (p.attention_id) markSeen(p.attention_id);
  const next = getPlan(id)!;
  const content = (shared
    ? { approve: `Plan looks good: ${p.title}`, changes: `Redirected: ${p.title}`, reject: `Stop: ${p.title}` }
    : { approve: `Plan approved: ${p.title}`, changes: `Plan sent back: ${p.title}`, reject: `Plan rejected: ${p.title}` })[verdict] + (note ? `\n\n${note}` : "");
  // "Looks good" on a shared plan needs no turn (the agent is already on it), unless there's a note.
  if (!(shared && verdict === "approve" && !note)) {
    const prompt = shared && verdict === "approve" ? `The owner looked at the plan you shared, ${JSON.stringify(p.title)}, and it's fine. Their note: ${note}` : decisionPrompt(next, verdict, note, shared);
    (deps.send ?? deliver)(getAgent(p.instance_id)!, next, content, prompt);
  }
  if (verdict === "approve") publish({ type: "plan_gate.updated", rootId: p.root_id, required: gateRequired(p.root_id) });
  return announce(id);
}

function deliver(agent: Agent | undefined, p: Plan, content: string, prompt: string) {
  let a = agent;
  if (!a) return;
  if (a.retired_at) {
    try { a = reviveInstance(a.id, a.created_by ?? "owner")!; } catch {
      run(`UPDATE agents SET retired_at = NULL WHERE id = ?`, a.id);
      a = getAgent(a.id)!;
      publish({ type: "agent.created", agent: { ...a, status: "idle", dm_thread_id: dmThreadOf(a.id) } });
    }
  }
  const threadId = (p.thread_id && get(`SELECT 1 FROM threads WHERE id = ?`, p.thread_id) ? p.thread_id : null) ?? dmThreadOf(a.id);
  if (!threadId) return;
  enqueueTask({
    agentId: a.id, threadId, source: "user", title: content.split("\n")[0].slice(0, 120), prompt: `[agentbox] ${prompt}`,
    parentTaskId: p.task_id, input: { author: "user", content },
  });
}

// --- enforcement and instructions -------------------------------------------------------------------------

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_WRITE = /\bgit\b[^;&|\n]*\s(commit|push|merge|rebase|cherry-pick)\b/;

/** PreToolUse: while the plan gate is closed, no edits inside repo worktrees and no commits or pushes. */
export function planGuard(agent: Agent) {
  return async (input: any) => {
    if (input?.hook_event_name !== "PreToolUse") return {};
    const tool = String(input.tool_name ?? "");
    if (!EDIT_TOOLS.has(tool) && tool !== "Bash") return {};
    if (!planBlocks(agent)) return {};
    let blocked = false;
    if (EDIT_TOOLS.has(tool)) {
      const target = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
      const abs = path.resolve(String(input.cwd ?? "/"), target);
      const root = worktreesRoot();
      blocked = abs === root || abs.startsWith(root + path.sep);
    } else {
      blocked = GIT_WRITE.test(String(input.tool_input?.command ?? ""));
    }
    if (!blocked) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "This work needs an approved plan first. Explore and read freely, then call mcp__team__submit_plan and end your turn; you'll get a message when the owner decides.",
      },
    };
  };
}

/** The work layer's plan section: only when the owner asked to approve a plan first (or did approve one). */
export function planNote(agent: Agent): string {
  if (!agent.base_agent_id || isSetupAgent(agent)) return "";
  const root = rootOf(agent);
  const plan = approvedPlan(root.id);
  if (plan) {
    return `## Approved plan (v${plan.version}): ${plan.title}
${plan.body.summary}
${plan.body.changes.map((c) => `- ${c}`).join("\n")}${plan.body.checks.length ? `\nChecks: ${plan.body.checks.join("; ")}` : ""}
Stay within it. If you change direction in a way the diagram wouldn't show, share a revised plan (submit_plan) and carry on.`;
  }
  if (!gateRequired(root.id)) return "";
  const pending = get<{ title: string; version: number }>(`SELECT title, version FROM plans WHERE root_id = ? AND status = 'pending' ORDER BY version DESC LIMIT 1`, root.id);
  return `## Plan first
The owner wants to approve a plan before anything changes in this work. Read and explore as much as you need, but
don't edit repo files, commit or push yet (agentbox refuses it). ${pending
    ? `Your plan "${pending.title}" (v${pending.version}) is waiting for the owner: end your turn unless you're revising it.`
    : "When you know what to do, call `mcp__team__submit_plan` and end your turn."}`;
}
