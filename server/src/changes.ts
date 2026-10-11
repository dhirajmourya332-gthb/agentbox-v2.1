import fs from "node:fs";
import path from "node:path";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { dmThreadOf, getAgent, instanceTree, reviveInstance, rootOf, type Agent } from "./agents.ts";
import { enqueueTask } from "./runner.ts";
import { getRepoById, git, worktreesFor, type Worktree } from "./repos.ts";

/**
 * Diff review (docs/V2.1-PLAN.md §2): what a piece of work changed in each repo worktree of its task
 * tree, against the point where its branch left the repo's default branch (committed, uncommitted and
 * new files alike), and the owner's review of it: line comments plus approve / request changes /
 * reject, delivered to the task as one message that starts its next turn.
 */

run(`CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,               -- the task (root instance) that was reviewed
  instance_id TEXT NOT NULL,           -- who got the review (the root, which routes rework)
  verdict TEXT NOT NULL,               -- approve | changes | reject
  note TEXT NOT NULL DEFAULT '',
  comments TEXT NOT NULL DEFAULT '[]', -- [{ worktree_id, repo, path, line, side, text }]
  heads TEXT NOT NULL DEFAULT '{}',    -- worktree id → HEAD reviewed (to show "changed since review")
  created_at TEXT NOT NULL
)`);
run(`CREATE INDEX IF NOT EXISTS reviews_root ON reviews(root_id, created_at)`);

export const LIMITS = { files: 300, untracked: 60, fileLines: 1500, totalLines: 20_000, untrackedBytes: 256_000 };

export type DiffLine = { t: "hunk" | "ctx" | "add" | "del"; s: string; o?: number; n?: number };
export type FileChange = {
  path: string; status: "added" | "modified" | "deleted" | "untracked";
  additions: number; deletions: number; binary: boolean; truncated: boolean; lines: DiffLine[];
};
export type RepoChanges = {
  worktree_id: string; repo: string; branch: string | null; base: string; path: string;
  instance: { id: string; name: string; label: string | null } | null;
  head: string | null; commits: { sha: string; subject: string }[];
  files: FileChange[]; additions: number; deletions: number; truncated: boolean; error: string | null;
};
export type Comment = { worktree_id: string; repo: string; path: string; line: number; side: "old" | "new"; text: string };
export type Review = { id: string; root_id: string; instance_id: string; verdict: Verdict; note: string; comments: Comment[]; heads: Record<string, string>; created_at: string };
export type Verdict = "approve" | "changes" | "reject";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Parse `git diff` output into files with numbered lines. */
export function parsePatch(patch: string, budget: { lines: number }): Map<string, { lines: DiffLine[]; truncated: boolean; binary: boolean }> {
  const out = new Map<string, { lines: DiffLine[]; truncated: boolean; binary: boolean }>();
  let cur: { lines: DiffLine[]; truncated: boolean; binary: boolean } | null = null;
  let o = 0, n = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // "diff --git a/<path> b/<path>" (no renames: both sides are the same path)
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
      cur = { lines: [], truncated: false, binary: false };
      if (m) out.set(m[2], cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("Binary files ")) { cur.binary = true; continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      o = Number(h[1]); n = Number(h[2]);
      if (!push(cur, { t: "hunk", s: raw }, budget)) continue;
      continue;
    }
    if (!cur.lines.length) continue; // still in the header (index, ---, +++, mode lines)
    if (raw.startsWith("+")) push(cur, { t: "add", s: raw.slice(1), n: n++ }, budget);
    else if (raw.startsWith("-")) push(cur, { t: "del", s: raw.slice(1), o: o++ }, budget);
    else if (raw.startsWith(" ")) push(cur, { t: "ctx", s: raw.slice(1), o: o++, n: n++ }, budget);
    // "\ No newline at end of file" and anything else: skipped
  }
  return out;
}
function push(f: { lines: DiffLine[]; truncated: boolean }, l: DiffLine, budget: { lines: number }) {
  if (f.truncated) return false;
  if (f.lines.length >= LIMITS.fileLines || budget.lines <= 0) { f.truncated = true; return false; }
  f.lines.push(l);
  budget.lines--;
  return true;
}

const G = (args: string[]) => ["-c", "core.quotePath=false", ...args];

/** The changes in one worktree, against where its branch left origin/<default branch>. */
export async function worktreeChanges(w: Worktree, budget = { lines: LIMITS.totalLines }): Promise<RepoChanges> {
  const repo = getRepoById(w.repo_id);
  const a = getAgent(w.instance_id);
  const base = `origin/${repo?.default_branch ?? "main"}`;
  const out: RepoChanges = {
    worktree_id: w.id, repo: repo?.name ?? "?", branch: w.branch, base, path: w.path ?? "",
    instance: a ? { id: a.id, name: a.name, label: a.label ?? null } : null,
    head: null, commits: [], files: [], additions: 0, deletions: 0, truncated: false, error: null,
  };
  if (!w.path || !fs.existsSync(w.path)) { out.error = w.status === "removed" ? "This worktree was removed when its task closed" : "The worktree isn't there"; return out; }
  const cwd = w.path;
  const head = await git(["rev-parse", "HEAD"], { cwd });
  out.head = head.code === 0 ? head.stdout.trim() : null;
  const mb = await git(["merge-base", "HEAD", base], { cwd });
  const from = mb.code === 0 ? mb.stdout.trim() : base;
  const log = await git(["log", "--format=%h%x09%s", "-n", "50", `${from}..HEAD`], { cwd });
  if (log.code === 0) out.commits = log.stdout.split("\n").filter(Boolean).map((l) => { const [sha, ...s] = l.split("\t"); return { sha, subject: s.join("\t") }; });

  const ns = await git(G(["diff", "--no-renames", "--numstat", from]), { cwd });
  const st = await git(G(["diff", "--no-renames", "--name-status", from]), { cwd });
  if (ns.code !== 0 || st.code !== 0) { out.error = "git diff failed"; return out; }
  const status = new Map<string, string>();
  for (const l of st.stdout.split("\n")) { const [s, ...p] = l.split("\t"); if (s && p.length) status.set(p.join("\t"), s); }
  const patch = await git(G(["diff", "--no-renames", "--no-color", "--no-ext-diff", "-U3", from]), { cwd, timeoutMs: 60_000 });
  const parsed = parsePatch(patch.stdout, budget);
  for (const l of ns.stdout.split("\n").filter(Boolean)) {
    if (out.files.length >= LIMITS.files) { out.truncated = true; break; }
    const [ad, de, ...p] = l.split("\t");
    const file = p.join("\t");
    const s = status.get(file) ?? "M";
    const binary = ad === "-";
    const pf = parsed.get(file);
    out.files.push({
      path: file, status: s === "A" ? "added" : s === "D" ? "deleted" : "modified",
      additions: binary ? 0 : Number(ad) || 0, deletions: binary ? 0 : Number(de) || 0,
      binary: binary || !!pf?.binary, truncated: !!pf?.truncated, lines: pf?.lines ?? [],
    });
  }

  // New files nobody has added yet: shown whole (text, small enough).
  const un = await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
  const untracked = un.code === 0 ? un.stdout.split("\0").filter(Boolean) : [];
  for (const file of untracked.slice(0, LIMITS.untracked)) {
    if (out.files.length >= LIMITS.files) { out.truncated = true; break; }
    const f: FileChange = { path: file, status: "untracked", additions: 0, deletions: 0, binary: false, truncated: false, lines: [] };
    try {
      const p = path.join(cwd, file);
      const size = fs.statSync(p).size;
      const buf = fs.readFileSync(p, { flag: "r" }).subarray(0, LIMITS.untrackedBytes);
      if (buf.includes(0)) f.binary = true;
      else {
        const text = buf.toString("utf8").replace(/\n$/, "");
        const lines = text === "" ? [] : text.split("\n");
        f.additions = lines.length;
        f.truncated = size > LIMITS.untrackedBytes;
        if (lines.length) push(f, { t: "hunk", s: `@@ -0,0 +1,${lines.length} @@ new file` }, budget);
        lines.forEach((s, i) => push(f, { t: "add", s, n: i + 1 }, budget));
      }
    } catch { f.binary = true; }
    out.files.push(f);
  }
  if (untracked.length > LIMITS.untracked) out.truncated = true;
  for (const f of out.files) { out.additions += f.additions; out.deletions += f.deletions; }
  if (budget.lines <= 0) out.truncated = true;
  return out;
}

/** The worktrees of a task and every instance it delegated to (onboarding ones included). */
export function treeWorktrees(rootId: string): Worktree[] {
  return instanceTree(rootId).flatMap((a) => worktreesFor(a.id)).filter((w) => w.status !== "discarded");
}

export const latestReview = (rootId: string) => {
  const r = get<any>(`SELECT * FROM reviews WHERE root_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, rootId);
  return r ? toReview(r) : null;
};
export const getReview = (id: string) => { const r = get<any>(`SELECT * FROM reviews WHERE id = ?`, id); return r ? toReview(r) : null; };
const toReview = (r: any): Review => ({ ...r, comments: JSON.parse(r.comments || "[]"), heads: JSON.parse(r.heads || "{}") });

export async function taskChanges(instanceId: string) {
  const a = getAgent(instanceId);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  const root = rootOf(a);
  const budget = { lines: LIMITS.totalLines };
  const repos: RepoChanges[] = [];
  for (const w of treeWorktrees(root.id)) repos.push(await worktreeChanges(w, budget));
  return { root_id: root.id, repos, review: latestReview(root.id) };
}

// --- the owner's review ----------------------------------------------------------------------------------

const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const block = (s: unknown, max: number) => String(s ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max);

export function reviewPrompt(r: Review, root: Agent) {
  const head = {
    approve: "The owner reviewed this work's changes and **approved** them.",
    changes: "The owner reviewed this work's changes and **requests changes**.",
    reject: "The owner reviewed this work's changes and **rejected** them.",
  }[r.verdict];
  const next = {
    approve: `Carry on: commit anything left, push, and open or update the PR (merge only if your rules allow it).${r.comments.length ? " Address the comments below that ask for something first." : ""}`,
    changes: "Address every comment below (fix it, or answer why not), re-run the checks, and report what you changed for each. If a comment is on a worktree another instance owns, send the rework to that instance.",
    reject: "Stop this approach: don't push, merge or deploy these changes. Report what you'd need to do differently, and wait for the owner.",
  }[r.verdict];
  const byFile = new Map<string, Comment[]>();
  for (const c of r.comments) {
    const k = `${c.repo}/${c.path}`;
    byFile.set(k, [...(byFile.get(k) ?? []), c]);
  }
  const comments = [...byFile.entries()].map(([file, cs]) =>
    cs.sort((x, y) => x.line - y.line).map((c) => `- ${file}:${c.line}${c.side === "old" ? " (removed line)" : ""}: ${c.text}`).join("\n")).join("\n");
  return `[agentbox] Review of "${root.label ?? root.name}". ${head}
${r.note ? `\nOwner's note: ${r.note}\n` : ""}${comments ? `\nComments (${r.comments.length}):\n${comments}\n` : ""}
${next}`;
}

export type ReviewInput = { verdict: string; note?: string; comments?: unknown[] };

/** The owner's review: stored, shown, and sent to the task (revived if it was closed). */
export async function submitReview(instanceId: string, input: ReviewInput, deps: { send?: (a: Agent, r: Review) => void } = {}): Promise<Review> {
  const a = getAgent(instanceId);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  const root = rootOf(a);
  const verdict = input.verdict as Verdict;
  if (!["approve", "changes", "reject"].includes(verdict)) throw httpError(400, "verdict: approve, changes or reject");
  const trees = treeWorktrees(root.id);
  const known = new Map(trees.map((w) => [w.id, w]));
  const comments: Comment[] = [];
  for (const c of (Array.isArray(input.comments) ? input.comments : []).slice(0, 200) as any[]) {
    const w = known.get(String(c?.worktree_id));
    const text = block(c?.text, 4000);
    const line = Number(c?.line);
    if (!w || !text || !Number.isInteger(line) || line < 0) continue;
    comments.push({ worktree_id: w.id, repo: getRepoById(w.repo_id)?.name ?? "?", path: oneLine(c.path, 500), line, side: c.side === "old" ? "old" : "new", text });
  }
  const note = block(input.note, 4000);
  if (verdict === "changes" && !note && !comments.length) throw httpError(400, "Say what to change: add a note or a comment on a line");
  const heads: Record<string, string> = {};
  for (const w of trees) {
    if (!w.path || !fs.existsSync(w.path)) continue;
    const h = await git(["rev-parse", "HEAD"], { cwd: w.path });
    if (h.code === 0) heads[w.id] = h.stdout.trim();
  }
  const id = newId();
  run(`INSERT INTO reviews (id, root_id, instance_id, verdict, note, comments, heads, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, root.id, root.id, verdict, note, JSON.stringify(comments), JSON.stringify(heads), now());
  const review = getReview(id)!;
  (deps.send ?? deliver)(root, review);
  publish({ type: "review.updated", rootId: root.id, review });
  return review;
}

function deliver(root: Agent, r: Review) {
  let a = getAgent(root.id)!;
  if (a.retired_at) {
    try { a = reviveInstance(a.id, a.created_by ?? "owner")!; } catch {
      run(`UPDATE agents SET retired_at = NULL WHERE id = ?`, a.id);
      a = getAgent(a.id)!;
      publish({ type: "agent.created", agent: { ...a, status: "idle", dm_thread_id: dmThreadOf(a.id) } });
    }
  }
  const threadId = dmThreadOf(a.id);
  if (!threadId) return;
  const title = { approve: "Review: approved", changes: `Review: changes requested (${r.comments.length} comment${r.comments.length === 1 ? "" : "s"})`, reject: "Review: rejected" }[r.verdict];
  // The thread shows the review as a card (content = its id); the agent gets the full text.
  enqueueTask({ agentId: a.id, threadId, source: "user", title, prompt: reviewPrompt(r, root), input: { author: "review", content: r.id } });
}

export const reviewsOf = (rootId: string) =>
  all<any>(`SELECT * FROM reviews WHERE root_id = ? ORDER BY created_at DESC LIMIT 50`, rootId).map(toReview);
