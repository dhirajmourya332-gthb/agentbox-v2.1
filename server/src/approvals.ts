import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { paths } from "./config.ts";
import { getAgent, listAgents, type Agent } from "./agents.ts";
import { ID_RE, rolesFor, setIntegrationRoles } from "./integrations.ts";
import { isSetupAgent } from "./setup.ts";

/**
 * Approval cards (docs/V2-ARCHITECTURE.md §10.4): the setup agent proposes a role mapping or a
 * team-rule change; nothing is applied until the owner clicks Approve in the portal (POST
 * /api/approvals/:id/approve, behind the portal's auth). No agent tool can approve. Proposals
 * from any other role are refused.
 */

export type ApprovalKind = "mapping" | "team_rule";
export type Approval = {
  id: string; kind: ApprovalKind; status: "pending" | "approved" | "rejected" | "failed";
  proposed_by: string; task_id: string | null; thread_id: string | null;
  title: string; payload: any; error: string | null; created_at: string; decided_at: string | null;
};

run(`CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- mapping | team_rule
  status TEXT NOT NULL,              -- pending | approved | rejected | failed
  proposed_by TEXT NOT NULL,
  task_id TEXT,
  thread_id TEXT,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,             -- JSON
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
)`);
run(`CREATE INDEX IF NOT EXISTS approvals_thread ON approvals(thread_id, created_at)`);

const row = (r: any): Approval | undefined => (r ? { ...r, payload: JSON.parse(r.payload) } : undefined);
export const getApproval = (id: string) => row(get(`SELECT * FROM approvals WHERE id = ?`, id));
export const listApprovals = (q: { threadId?: string; status?: string } = {}) =>
  all(
    `SELECT * FROM approvals WHERE (? IS NULL OR thread_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 200`,
    q.threadId ?? null, q.threadId ?? null, q.status ?? null, q.status ?? null,
  ).map((r) => row(r)!);

function mustSetup(agent: Agent) {
  if (!isSetupAgent(agent)) throw new Error("Only the setup agent can propose integration mappings and team-rule changes.");
}

function create(agent: Agent, taskId: string | null, kind: ApprovalKind, title: string, payload: unknown): Approval {
  const thread = taskId ? get<{ thread_id: string }>(`SELECT thread_id FROM tasks WHERE id = ?`, taskId)?.thread_id ?? null : null;
  const a: Approval = {
    id: newId(), kind, status: "pending", proposed_by: agent.id, task_id: taskId, thread_id: thread,
    title, payload, error: null, created_at: now(), decided_at: null,
  };
  run(
    `INSERT INTO approvals (id, kind, status, proposed_by, task_id, thread_id, title, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id, a.kind, a.status, a.proposed_by, a.task_id, a.thread_id, a.title, JSON.stringify(a.payload), a.created_at,
  );
  // The card sits in the chat where it was proposed (author "approval", content = its id).
  if (thread) {
    const message = { id: newId(), thread_id: thread, author: "approval", task_id: null, content: a.id, created_at: now() };
    run(
      `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
    );
    publish({ type: "message.created", message });
  }
  publish({ type: "approval.updated", approval: a });
  return a;
}

// --- role mapping ------------------------------------------------------------------------------

/** Roles by id, slug or name; only base roles, never the setup agent itself. */
function resolveRoles(names: string[]) {
  const roles = listAgents().filter((a) => !a.base_agent_id && !a.builtin);
  const out: Agent[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const k = String(n).trim().toLowerCase().replace(/^@/, "");
    const r = roles.find((a) => a.id === n || a.slug === k || a.name.toLowerCase() === k);
    if (r) { if (!out.includes(r)) out.push(r); } else unknown.push(String(n));
  }
  return { out, unknown, available: roles.map((r) => r.name) };
}

export function proposeMapping(agent: Agent, taskId: string | null, integrationId: string, roleNames: string[], title?: string) {
  mustSetup(agent);
  if (!ID_RE.test(integrationId)) throw new Error("Unknown integration id");
  const { out, unknown, available } = resolveRoles(roleNames ?? []);
  if (unknown.length) throw new Error(`No agent called ${unknown.map((u) => `"${u}"`).join(", ")}. Agents: ${available.join(", ") || "none"}.`);
  const before = rolesFor(integrationId);
  const after = out.map((r) => r.id);
  return create(agent, taskId, "mapping", `Which agents use ${title ?? integrationId}`, {
    integration_id: integrationId, integration_title: title ?? integrationId,
    roles: after, before, added: after.filter((r) => !before.includes(r)), removed: before.filter((r) => !after.includes(r)),
  });
}

// --- team rules ---------------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A team-rule file: a .md directly in /team or a subfolder, never the rendered integrations/. */
export function teamFile(file: string): string {
  const root = path.resolve(paths.team);
  const f = String(file ?? "").trim();
  let abs: string;
  if (f.startsWith(root + path.sep)) abs = path.resolve(f);
  else if (f.startsWith("/team/")) abs = path.resolve(root, f.slice("/team/".length));
  else if (path.isAbsolute(f)) throw new Error(`Team rules live in ${root}/`);
  else abs = path.resolve(root, f);
  if (!abs.startsWith(root + path.sep)) throw new Error(`Team rules live in ${root}/`);
  if (!/\.md$/i.test(abs)) throw new Error("Team rules are Markdown files (.md)");
  const relative = path.relative(root, abs);
  if (relative.split(path.sep)[0] === "integrations") throw new Error("Files under integrations/ are rendered by agentbox; change the integration's settings instead");
  if (relative.split(path.sep).some((p) => p.startsWith("."))) throw new Error("No hidden files");
  // No symlink may lead outside /team.
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir.length > root.length) dir = path.dirname(dir);
  if (fs.existsSync(dir)) {
    const real = fs.realpathSync(dir);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error("That path leaves the team folder");
  }
  if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new Error("That file is a link; edit its target instead");
  return abs;
}

const readOr = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

/** A line diff (LCS) for the card: ` ` same, `-` removed, `+` added. Long files fall back to a full swap. */
export function lineDiff(a: string, b: string): { op: " " | "-" | "+"; text: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ op: "-" as const, text: t })), ...y.map((t) => ({ op: "+" as const, text: t }))];
  const n = x.length, m = y.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: " " | "-" | "+"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: " ", text: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}

export function proposeTeamRule(agent: Agent, taskId: string | null, file: string, content: string, reason = "") {
  mustSetup(agent);
  const abs = teamFile(file);
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("The proposed file is empty; to remove a rule, propose the file without it");
  if (text.length > 100_000) throw new Error("That file is too long (100 kB max)");
  const current = readOr(abs);
  if (current === text) throw new Error("That's the file as it is now; nothing to change");
  const rel = path.relative(path.resolve(paths.team), abs);
  return create(agent, taskId, "team_rule", `${current === null ? "New team rule" : "Change team rule"}: ${rel}`, {
    file: abs, relative: rel, reason: String(reason ?? "").slice(0, 2000), content: text,
    base_hash: current === null ? null : sha(current), created: current === null,
    diff: lineDiff(current ?? "", text),
  });
}

// --- the owner's decision -----------------------------------------------------------------------

function decide(a: Approval, status: Approval["status"], error: string | null = null) {
  run(`UPDATE approvals SET status = ?, error = ?, decided_at = ? WHERE id = ?`, status, error, now(), a.id);
  const next = getApproval(a.id)!;
  publish({ type: "approval.updated", approval: next });
  return next;
}

/** Apply a pending proposal. Only called from the owner's POST route. */
export function approve(id: string): Approval {
  const a = getApproval(id);
  if (!a) throw Object.assign(new Error("No such approval"), { statusCode: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`Already ${a.status}`), { statusCode: 409 });
  if (a.kind === "mapping") {
    const roles = (a.payload.roles as string[]).filter((r) => { const x = getAgent(r); return x && !x.base_agent_id && !x.retired_at; });
    setIntegrationRoles(a.payload.integration_id, roles);
    return decide(a, "approved");
  }
  // Team rule: the file must still be what the proposal was based on; then one atomic rename.
  const abs = teamFile(a.payload.file);
  const current = readOr(abs);
  const base = current === null ? null : sha(current);
  if (base !== a.payload.base_hash) {
    throw Object.assign(new Error(`${a.payload.relative} changed since this was proposed; ask the setup agent to propose it again`), { statusCode: 409 });
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, a.payload.content, { mode: 0o644 });
  fs.renameSync(tmp, abs);
  return decide(a, "approved");
}

export function reject(id: string): Approval {
  const a = getApproval(id);
  if (!a) throw Object.assign(new Error("No such approval"), { statusCode: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`Already ${a.status}`), { statusCode: 409 });
  return decide(a, "rejected");
}
