import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import YAML from "yaml";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { paths } from "./config.ts";
import { dmThreadOf, getAgent, reviveInstance, spawnInstance, type Agent } from "./agents.ts";
import { enqueueTask } from "./runner.ts";
import { clonePath, getRepo, getRepoById, git, inside, listRepos, roleAllowed, urlKey, worktreesFor, type Repo } from "./repos.ts";

/**
 * Repo memory (docs/TREE-MEMORY.md): what agents learned about a repo, kept as a tree of short markdown
 * notes at <paths.work>/memory/<repo>/. The agents own the tree: folder and file names, layout and the
 * INDEX.md in each folder are theirs; agentbox imposes no taxonomy. agentbox keeps three things true:
 *
 * - Knowledge lands only when work merges to main. While a task works on a branch, its notes go to the
 *   task's draft folder (<paths.work>/memory-drafts/<repo>/<task>/). When its PR merges into the default
 *   branch (followed through an epic branch), the agent that did the work is woken to fold its drafts into
 *   the tree. A PR closed unmerged discards them.
 * - Notes are anchored to code (`path` or `path#symbol`). Anchors are hashed at origin/<default>; when main
 *   moves, a plain program (no model, no tokens) re-hashes them and marks notes whose anchored code changed
 *   as `stale:`. Nothing reworks a stale note until an agent reads it for its task: then it re-verifies and
 *   rewrites it. Changes elsewhere in an anchored file don't mark it stale.
 * - Writes are safe with many agents: the tree is read-only to file tools and shell writes (repoGuard);
 *   changes go through memory_write / memory_move / memory_delete, serialized per repo, and an edit must
 *   name the note's current `rev` (read-modify-write without losing someone else's change).
 */

const runFile = promisify(execFile);

run(`CREATE TABLE IF NOT EXISTS memory_drafts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,           -- the task whose notes these are
  role_id TEXT,
  branch TEXT,                         -- the task's branch
  watch_branch TEXT,                   -- where its work is now (an epic branch it merged into), else = branch
  status TEXT NOT NULL,                -- open | promoting | promoted | discarded | empty
  pr_number INTEGER,
  pr_url TEXT,
  merge_commit TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, instance_id)
)`);
run(`CREATE TABLE IF NOT EXISTS memory_scans (
  repo_id TEXT PRIMARY KEY,
  head TEXT NOT NULL,                  -- origin/<default> when the notes were last checked
  scanned_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
)`);

export const LIMITS = { noteBytes: 24_000, depth: 8, anchors: 20, blockLines: 400, draftDays: 30 };

export type Draft = {
  id: string; repo_id: string; instance_id: string; role_id: string | null; branch: string | null; watch_branch: string | null;
  status: "open" | "promoting" | "promoted" | "discarded" | "empty"; pr_number: number | null; pr_url: string | null;
  merge_commit: string | null; note: string | null; created_at: string; updated_at: string;
};

// --- paths ---------------------------------------------------------------------------------------------

export const memoryRoot = () => path.resolve(paths.work, "memory");
export const draftsRoot = () => path.resolve(paths.work, "memory-drafts");
export const repoMemoryDir = (repo: string) => inside(memoryRoot(), repo);
const shortId = (instanceId: string) => instanceId.replace(/-/g, "").slice(0, 8);
export const draftDir = (repo: string, instanceId: string) => inside(draftsRoot(), repo, shortId(instanceId));

const SEG_RE = /^(?!\.)[A-Za-z0-9._-]{1,80}$/;

/** A note's path inside a repo's tree: relative, plain segments, .md (or a folder, when `folder`). */
export function notePath(rel: unknown, opts: { folder?: boolean; repo?: string } = {}): string {
  let raw = String(rel ?? "").trim().replace(/\\/g, "/");
  if (raw.startsWith("/")) {
    // A full path is fine when it's inside this repo's tree.
    const tree = opts.repo ? repoMemoryDir(opts.repo) : null;
    if (!tree || !(raw === tree || raw.startsWith(tree + "/"))) throw new Error(`"${raw}" is outside the repo's memory${tree ? ` (${tree}/)` : ""}: give a path inside it`);
    raw = raw.slice(tree.length);
  }
  const s = raw.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const segs = s.split("/").filter(Boolean);
  if (!segs.length) throw new Error("Give a path inside the repo's memory, e.g. portal-a/auth.md");
  if (segs.length > LIMITS.depth) throw new Error(`Keep the tree at most ${LIMITS.depth} levels deep`);
  const bad = segs.find((x) => !SEG_RE.test(x) || x === "..");
  if (bad) throw new Error(`"${bad}": use letters, digits, '.', '_' and '-' in names (no leading dot)`);
  if (!opts.folder && !segs.at(-1)!.endsWith(".md")) throw new Error("Notes are markdown files (.md)");
  return segs.join("/");
}

const exists = (p: string) => { try { fs.statSync(p); return true; } catch { return false; } };

/** Every note file in a tree (relative paths). */
export function listNotes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

// --- notes: frontmatter -----------------------------------------------------------------------------------

export type Anchor = { file: string; symbol: string | null; hash: string | null };
export type Note = { meta: Record<string, unknown>; body: string; rev: number; anchors: Anchor[]; stale: string | null };

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseAnchor(s: string): Anchor {
  const m = String(s).trim().match(/^(.+?)(?:#([^\s@]+))?(?:\s+@([0-9a-f]{6,64}))?$/);
  if (!m) throw new Error(`Anchor "${s}": write it as path/in/repo or path/in/repo#symbol`);
  const file = m[1].trim().replace(/^\.?\/+/, "");
  if (!file || file.split("/").includes("..") || path.isAbsolute(file)) throw new Error(`Anchor "${s}": a path inside the repo`);
  return { file, symbol: m[2] ?? null, hash: m[3] ?? null };
}
const anchorText = (a: Anchor) => `${a.file}${a.symbol ? `#${a.symbol}` : ""}${a.hash ? ` @${a.hash}` : ""}`;

export function parseNote(text: string): Note {
  const m = text.match(FM_RE);
  let meta: Record<string, unknown> = {};
  if (m) {
    try { const v = YAML.parse(m[1]); if (v && typeof v === "object" && !Array.isArray(v)) meta = v; } catch { meta = {}; }
  }
  const body = m ? text.slice(m[0].length) : text;
  const raw = meta.anchors;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/,\s*/) : [];
  const anchors = list.filter((x) => x.trim()).map(parseAnchor);
  const rev = Number(meta.rev) || 0;
  return { meta, body, rev, anchors, stale: meta.stale ? String(meta.stale) : null };
}

/** The note as written to disk: the agent's own fields first, then agentbox's (rev, verified, anchors, stale). */
export function renderNote(n: { meta: Record<string, unknown>; body: string }, sys: { rev: number; verified?: string | null; anchors: Anchor[]; stale?: string | null }) {
  const own = Object.fromEntries(Object.entries(n.meta).filter(([k]) => !["rev", "verified", "anchors", "stale"].includes(k)));
  const meta: Record<string, unknown> = { ...own, rev: sys.rev };
  if (sys.verified) meta.verified = sys.verified;
  if (sys.anchors.length) meta.anchors = sys.anchors.map(anchorText);
  if (sys.stale) meta.stale = sys.stale;
  const fm = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${n.body.replace(/^\s*\n/, "")}`;
}

// --- anchors: hashing what a note describes ------------------------------------------------------------

const DEF_KW = "(?:export\\s+)?(?:default\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|abstract\\s+|override\\s+|readonly\\s+)*(?:function\\*?|class|def|func|fn|interface|type|enum|struct|trait|module|const|let|var|val)";

/**
 * The lines a symbol covers in a file: its definition line (a declaration keyword before the name, or the
 * name as a method / property / assignment at the start of a line), through the end of its block (the next
 * line indented no deeper than the definition, closing brackets and `end` included). Language-agnostic.
 */
export function symbolBlock(source: string, symbol: string): string | null {
  const lines = source.split(/\r?\n/);
  const sym = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = new RegExp(`(^|[^\\w$])${DEF_KW}\\s+${sym}(?![\\w$])`);
  const member = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\\s+)*["']?${sym}["']?\\s*(?:[(=:<]|\\?\\s*[(:])`);
  let start = lines.findIndex((l) => decl.test(l));
  if (start < 0) start = lines.findIndex((l) => member.test(l));
  if (start < 0) return null;
  const indent = (l: string) => l.match(/^\s*/)![0].replace(/\t/g, "    ").length;
  const base = indent(lines[start]);
  let end = start;
  for (let i = start + 1; i < lines.length && i - start < LIMITS.blockLines; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) <= base) {
      if (/^\s*([}\])]|end\b|fi\b|done\b|esac\b)/.test(l)) end = i;
      break;
    }
    end = i;
  }
  return lines.slice(start, end + 1).join("\n");
}

/** Whitespace-insensitive: reformatting (indentation, blank lines, trailing spaces) doesn't change the hash. */
const normalize = (s: string) => s.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** A file's content at a ref of the canonical clone (null: no such file). */
async function showFile(canon: string, ref: string, file: string, cache?: Map<string, string | null>): Promise<string | null> {
  const key = `${ref}:${file}`;
  if (cache?.has(key)) return cache.get(key)!;
  const r = await git(["show", `${ref}:${file}`], { cwd: canon, timeoutMs: 60_000 });
  const v = r.code === 0 ? r.stdout : null;
  cache?.set(key, v);
  return v;
}

/** The anchor's hash at `ref` (null: the file or symbol isn't there). */
export async function anchorHash(canon: string, ref: string, a: Anchor, cache?: Map<string, string | null>): Promise<string | null> {
  const src = await showFile(canon, ref, a.file, cache);
  if (src === null) return null;
  if (!a.symbol) return sha(normalize(src));
  const block = symbolBlock(src, a.symbol);
  return block === null ? null : sha(normalize(block));
}

async function headOf(repo: Repo): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${repo.default_branch}`], { cwd: clonePath(repo.name) });
  return r.code === 0 ? r.stdout.trim() : null;
}

// --- writes (serialized per repo) -------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

function writeAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const changed = (repo: Repo) => publish({ type: "memory.updated", repo: repo.name });

function usableRepo(agent: Agent, name: string): Repo {
  const repo = getRepo(String(name ?? "").trim());
  if (!repo || repo.status === "archived") throw new Error(`No repo called "${name}"`);
  if (!agent.base_agent_id) throw new Error("Repo memory is written by tasks (instances)");
  if (!roleAllowed(repo, agent)) throw new Error(`Your role isn't allowed to use ${repo.name}`);
  if (!exists(path.join(clonePath(repo.name), ".git"))) throw new Error(`${repo.name}'s clone is missing`);
  return repo;
}

const draftOf = (repoId: string, instanceId: string) => get<Draft>(`SELECT * FROM memory_drafts WHERE repo_id = ? AND instance_id = ?`, repoId, instanceId);
const promoting = (repo: Repo, agent: Agent) => draftOf(repo.id, agent.id)?.status === "promoting";

/** In the parent folder's INDEX.md? (A reminder, not a rule: the agents own the indexes.) */
function indexMentions(dir: string, rel: string) {
  if (path.basename(rel) === "INDEX.md") return true;
  const idx = path.join(dir, path.dirname(rel), "INDEX.md");
  try { return fs.readFileSync(idx, "utf8").includes(path.basename(rel)); } catch { return false; }
}

/** memory_write: create (only while folding in merged work) or update (with its current rev) a note. */
export function writeNote(agent: Agent, input: { repo: unknown; path: unknown; content: unknown; rev?: unknown }): Promise<string> {
  const repo = usableRepo(agent, String(input.repo ?? ""));
  const rel = notePath(input.path, { repo: repo.name });
  const content = String(input.content ?? "");
  if (!content.trim()) throw new Error("Empty note: use memory_delete to remove one");
  if (Buffer.byteLength(content) > LIMITS.noteBytes) throw new Error(`Keep a note under ${LIMITS.noteBytes / 1000} KB: split it, and link the parts from the folder's INDEX.md`);
  return withLock(repo.id, async () => {
    const dir = repoMemoryDir(repo.name);
    const file = inside(dir, ...rel.split("/"));
    const current = exists(file) ? parseNote(fs.readFileSync(file, "utf8")) : null;
    if (current) {
      const rev = Number(input.rev);
      if (!Number.isFinite(rev) || input.rev === undefined || input.rev === null || input.rev === "") {
        throw new Error(`${rel} exists (rev ${current.rev}): read it, merge your change into it, and pass rev ${current.rev}`);
      }
      if (rev !== current.rev) throw new Error(`${rel} changed since you read it (rev ${rev} → ${current.rev}). Read it again, merge your change, and pass rev ${current.rev}`);
    } else if (!promoting(repo, agent)) {
      throw new Error(`New notes land when your work merges to ${repo.default_branch}. For now, write it to your task's draft folder: ${draftDir(repo.name, agent.id)}/${rel}`);
    }
    const note = parseNote(content);
    if (note.anchors.length > LIMITS.anchors) throw new Error(`At most ${LIMITS.anchors} anchors per note: split it`);
    const head = await headOf(repo);
    if (note.anchors.length && !head) throw new Error(`Can't read origin/${repo.default_branch} in ${repo.name}'s clone`);
    const cache = new Map<string, string | null>();
    const anchors: Anchor[] = [];
    const missing: string[] = [];
    for (const a of note.anchors) {
      const h = await anchorHash(clonePath(repo.name), head!, a, cache);
      if (h === null) missing.push(anchorText({ ...a, hash: null }));
      else anchors.push({ ...a, hash: h });
    }
    if (missing.length) {
      throw new Error(`Not on origin/${repo.default_branch} (${head!.slice(0, 12)}): ${missing.join(", ")}. Anchor to code that's on ${repo.default_branch}: a path, or path#name of a function, class, method or constant defined there`);
    }
    const rev = (current?.rev ?? 0) + 1;
    const verified = head ? `${head.slice(0, 12)} ${now().slice(0, 10)} by ${agent.name}` : `${now().slice(0, 10)} by ${agent.name}`;
    writeAtomic(file, renderNote(note, { rev, verified, anchors }));
    changed(repo);
    const hints = [
      anchors.length ? `anchored to ${anchors.length} place(s) at ${head!.slice(0, 12)}` : "no anchors (it never goes stale; anchor notes that describe code)",
      indexMentions(dir, rel) ? "" : `${path.dirname(rel) === "." ? "INDEX.md" : `${path.dirname(rel)}/INDEX.md`} doesn't list it yet: add a line`,
    ].filter(Boolean);
    return `Saved ${rel} (rev ${rev}; ${hints.join("; ")}).`;
  });
}

/** memory_move: reorganise (a note or a folder). */
export function moveNote(agent: Agent, input: { repo: unknown; from: unknown; to: unknown }): Promise<string> {
  const repo = usableRepo(agent, String(input.repo ?? ""));
  const from = notePath(input.from, { folder: true, repo: repo.name });
  const to = notePath(input.to, { folder: true, repo: repo.name });
  return withLock(repo.id, async () => {
    const dir = repoMemoryDir(repo.name);
    const src = inside(dir, ...from.split("/"));
    const dst = inside(dir, ...to.split("/"));
    if (!exists(src)) throw new Error(`${from} doesn't exist`);
    if (exists(dst)) throw new Error(`${to} already exists`);
    if (fs.statSync(src).isFile() && !to.endsWith(".md")) throw new Error("Notes are markdown files (.md)");
    if (dst.startsWith(src + path.sep)) throw new Error("Can't move a folder into itself");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    pruneEmpty(dir, path.dirname(src));
    changed(repo);
    return `Moved ${from} → ${to}. Update the INDEX.md files that listed it.`;
  });
}

/** memory_delete: a note, or a whole folder. */
export function deleteNote(agent: Agent, input: { repo: unknown; path: unknown }): Promise<string> {
  const repo = usableRepo(agent, String(input.repo ?? ""));
  const rel = notePath(input.path, { folder: true, repo: repo.name });
  return withLock(repo.id, async () => {
    const dir = repoMemoryDir(repo.name);
    const p = inside(dir, ...rel.split("/"));
    if (!exists(p)) throw new Error(`${rel} doesn't exist`);
    fs.rmSync(p, { recursive: true, force: true });
    pruneEmpty(dir, path.dirname(p));
    changed(repo);
    return `Deleted ${rel}. Update the INDEX.md that listed it.`;
  });
}

function pruneEmpty(root: string, d: string) {
  while (d.startsWith(root + path.sep)) {
    try { if (fs.readdirSync(d).length) return; fs.rmdirSync(d); } catch { return; }
    d = path.dirname(d);
  }
}

// --- staleness (no model, no tokens) ----------------------------------------------------------------------

/** Re-hash every anchored note against origin/<default> when it moved; mark (or clear) `stale:`. */
export async function scanRepo(repo: Repo, opts: { force?: boolean } = {}): Promise<{ checked: number; stale: number; marked: number } | null> {
  const dir = repoMemoryDir(repo.name);
  const canon = clonePath(repo.name);
  if (!exists(dir) || !exists(path.join(canon, ".git"))) return null;
  const head = await headOf(repo);
  if (!head) return null;
  const last = get<{ head: string }>(`SELECT head FROM memory_scans WHERE repo_id = ?`, repo.id);
  if (!opts.force && last?.head === head) return null;
  return withLock(repo.id, async () => {
    const cache = new Map<string, string | null>();
    let checked = 0, stale = 0, marked = 0;
    for (const rel of listNotes(dir)) {
      const file = path.join(dir, rel);
      let text: string;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const note = parseNote(text);
      const hashed = note.anchors.filter((a) => a.hash);
      if (!hashed.length) continue;
      checked++;
      const moved: Anchor[] = [];
      for (const a of hashed) if ((await anchorHash(canon, head, a, cache)) !== a.hash) moved.push(a);
      let why: string | null = null;
      if (moved.length) {
        stale++;
        const since = String(note.meta.verified ?? "").split(/\s+/)[0];
        const commits = new Set<string>();
        if (/^[0-9a-f]{7,40}$/.test(since)) {
          for (const a of moved) {
            const r = await git(["log", "--format=%h", "-n", "3", `${since}..${head}`, "--", a.file], { cwd: canon, timeoutMs: 30_000 });
            if (r.code === 0) r.stdout.split("\n").filter(Boolean).forEach((c) => commits.add(c));
          }
        }
        why = `${moved.map((a) => `${a.file}${a.symbol ? `#${a.symbol}` : ""}`).join(", ")} changed on ${repo.default_branch}${commits.size ? ` (${[...commits].slice(0, 5).join(", ")})` : ""} since it was verified; re-verify against the code before relying on it, then rewrite it with memory_write`;
      }
      if ((why ?? null) === note.stale) continue;
      writeAtomic(file, renderNote(note, { rev: note.rev, verified: note.meta.verified ? String(note.meta.verified) : null, anchors: note.anchors, stale: why }));
      marked++;
    }
    run(`INSERT INTO memory_scans (repo_id, head, scanned_at, stale) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET head = excluded.head, scanned_at = excluded.scanned_at, stale = excluded.stale`, repo.id, head, now(), stale);
    if (marked) changed(repo);
    return { checked, stale, marked };
  });
}

// --- drafts: branch work, folded in when it merges ----------------------------------------------------------

const draftView = (d: Draft) => {
  const a = getAgent(d.instance_id);
  const repo = getRepoById(d.repo_id);
  return { ...d, repo: repo?.name ?? null, dir: repo ? draftDir(repo.name, d.instance_id) : null, notes: repo ? listNotes(draftDir(repo.name, d.instance_id)).length : 0, agent_name: a?.name ?? null };
};

/** A draft row for each repo the task works on (its folder is created when the agent writes to it). */
export function ensureDrafts(agent: Agent): Draft[] {
  if (!agent.base_agent_id) return [];
  const out: Draft[] = [];
  for (const w of worktreesFor(agent.id)) {
    if (w.purpose === "onboard" || !["active", "pending", "kept"].includes(w.status)) continue;
    let d = draftOf(w.repo_id, agent.id);
    if (!d) {
      run(`INSERT INTO memory_drafts (id, repo_id, instance_id, role_id, branch, watch_branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        newId(), w.repo_id, agent.id, agent.base_agent_id, w.branch, w.branch, now(), now());
      d = draftOf(w.repo_id, agent.id)!;
    } else if (w.branch && !d.branch) {
      run(`UPDATE memory_drafts SET branch = ?, watch_branch = COALESCE(watch_branch, ?), updated_at = ? WHERE id = ?`, w.branch, w.branch, now(), d.id);
      d = draftOf(w.repo_id, agent.id)!;
    }
    out.push(d);
  }
  return out;
}

type PrState = { merged?: { number: number; base: string; commit: string | null; url: string | null }; open: boolean; closed: boolean } | null;

/** The PRs from `branch` (GitHub: gh pr list). null: couldn't tell (no gh, another provider, offline). */
async function prsFrom(repo: Repo, branch: string): Promise<PrState> {
  if (repo.provider !== "github") return null;
  const slug = urlKey(repo.url)?.split("/").slice(-2).join("/");
  if (!slug) return null;
  try {
    const { stdout } = await runFile(process.env.AGENTBOX_GH ?? "gh", ["pr", "list", "-R", slug, "--head", branch, "--state", "all", "--limit", "10", "--json", "number,state,baseRefName,mergeCommit,url"], { timeout: 30_000 });
    const prs: any[] = JSON.parse(stdout);
    if (!Array.isArray(prs)) return null;
    const m = prs.find((p) => String(p.state).toUpperCase() === "MERGED");
    return {
      merged: m ? { number: Number(m.number), base: String(m.baseRefName), commit: m.mergeCommit?.oid ?? null, url: m.url ?? null } : undefined,
      open: prs.some((p) => String(p.state).toUpperCase() === "OPEN"),
      closed: prs.length > 0 && prs.every((p) => String(p.state).toUpperCase() === "CLOSED"),
    };
  } catch { return null; }
}

/** Without a provider API: is the branch's work in origin/<default> (merge or fast-forward; not squash)? */
async function mergedByGit(repo: Repo, branch: string, since: string): Promise<boolean> {
  const canon = clonePath(repo.name);
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const tip = await git(["rev-parse", "--verify", "--quiet", ref], { cwd: canon });
    if (tip.code !== 0) continue;
    const sha = tip.stdout.trim();
    const anc = await git(["merge-base", "--is-ancestor", sha, `refs/remotes/origin/${repo.default_branch}`], { cwd: canon });
    if (anc.code !== 0) return false;
    // The branch's own commits: a branch with none is "in main" trivially.
    const t = await git(["log", "-1", "--format=%cI", sha], { cwd: canon });
    return t.code === 0 && Date.parse(t.stdout.trim()) >= Date.parse(since) - 60_000;
  }
  return false;
}

const remoteHas = async (repo: Repo, branch: string) =>
  (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: clonePath(repo.name) })).code === 0;

function setDraft(id: string, patch: Partial<Draft>) {
  const keys = Object.keys(patch);
  run(`UPDATE memory_drafts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (patch as any)[k]), now(), id);
  const d = get<Draft>(`SELECT * FROM memory_drafts WHERE id = ?`, id)!;
  publish({ type: "memory.updated", draft: draftView(d) });
  return d;
}

function discard(d: Draft, repo: Repo, why: string) {
  try { fs.rmSync(draftDir(repo.name, d.instance_id), { recursive: true, force: true }); } catch { /* gone */ }
  setDraft(d.id, { status: "discarded", note: why });
}

const live = (id: string) => { const a = getAgent(id); return !!a && !a.retired_at; };

/** Follow an open draft: merged into the default branch → fold in; into an epic → follow the epic; closed → discard. */
export async function checkDraft(d: Draft): Promise<Draft> {
  const repo = getRepoById(d.repo_id);
  if (!repo || repo.status === "archived") return d;
  const branch = d.watch_branch ?? d.branch;
  const notes = listNotes(draftDir(repo.name, d.instance_id)).length;
  const old = Date.now() - Date.parse(d.created_at) > LIMITS.draftDays * 24 * 3600_000;
  if (!branch) {
    if (!live(d.instance_id) && old) return setDraft(d.id, { status: notes ? "discarded" : "empty", note: "the task never got a branch" });
    return d;
  }
  const pr = await prsFrom(repo, branch);
  let merged: { base: string; number: number | null; commit: string | null; url: string | null } | null = null;
  if (pr?.merged) merged = { ...pr.merged };
  else if (!pr && await mergedByGit(repo, branch, d.created_at)) merged = { base: repo.default_branch!, number: null, commit: null, url: null };

  if (merged && merged.base !== repo.default_branch) {
    // Merged into an epic (or another integration branch): knowledge waits until that reaches main.
    return setDraft(d.id, { watch_branch: merged.base, note: `merged into ${merged.base}${merged.number ? ` (#${merged.number})` : ""}; waiting for ${merged.base} to reach ${repo.default_branch}` });
  }
  if (merged) {
    if (!notes) return setDraft(d.id, { status: "empty", pr_number: merged.number ?? d.pr_number, pr_url: merged.url ?? d.pr_url, merge_commit: merged.commit, note: "merged; no notes to fold in" });
    return promote(setDraft(d.id, { pr_number: merged.number ?? d.pr_number, pr_url: merged.url ?? d.pr_url, merge_commit: merged.commit }), repo);
  }
  if (live(d.instance_id)) return d;
  // The task is closed and its work isn't merged.
  if (pr?.closed && !pr.open) { discard(d, repo, `the PR from ${branch} was closed without merging`); return draftOf(d.repo_id, d.instance_id)!; }
  if (!pr?.open && !(await remoteHas(repo, branch)) && worktreesFor(d.instance_id).every((w) => w.status !== "kept")) {
    if (!notes) return setDraft(d.id, { status: "empty", note: "closed without a pushed branch" });
    discard(d, repo, `${branch} was never pushed and the task is closed`);
    return draftOf(d.repo_id, d.instance_id)!;
  }
  if (old) { discard(d, repo, `not merged after ${LIMITS.draftDays} days`); return draftOf(d.repo_id, d.instance_id)!; }
  return d;
}

export function promotionPrompt(repo: Repo, d: Draft) {
  const drafts = draftDir(repo.name, d.instance_id);
  const tree = repoMemoryDir(repo.name);
  const what = d.pr_number ? `PR #${d.pr_number}` : `Your branch ${d.branch}`;
  return `[agentbox] ${what} merged into ${repo.default_branch}${d.merge_commit ? ` (${d.merge_commit.slice(0, 12)})` : ""}. Fold your working notes into ${repo.name}'s memory, so the next agent finds them.

- Your drafts: ${drafts}/
- The repo's memory: ${tree}/ (start with INDEX.md; it may be empty)

1. Read the tree's INDEX.md files along the paths that matter, and the notes your drafts overlap with.
2. Keep only what the code can't tell quickly and is now true on ${repo.default_branch}: decisions and why, gotchas, where things live, conventions, dead code. Drop task chatter and restatements of code.
3. Prefer extending an existing note (memory_write with its rev) over a new one; put new ones where the tree's structure says they belong (you may reorganise with memory_move). Be specific in names when there are several variants (portal-a/auth.md, not auth.md).
4. Anchor each note that describes code (\`anchors:\` in its frontmatter: path or path#symbol on ${repo.default_branch}).
5. Keep the INDEX.md of every folder you touched current: one line per note or subfolder.
6. Call mcp__team__memory_promoted with repo "${repo.name}" when done (or if nothing is worth keeping). It removes the drafts.

Keep it brief: a few precise notes beat many long ones.`;
}

function promote(d: Draft, repo: Repo): Draft {
  let a = getAgent(d.instance_id);
  try {
    if (a?.retired_at) a = reviveInstance(a.id, a.created_by ?? "owner") ?? a;
  } catch { /* at its limit: a fresh instance of the role does it below */ a = undefined; }
  if (!a || a.retired_at) {
    const role = d.role_id ? getAgent(d.role_id) : undefined;
    if (!role || role.retired_at) return setDraft(d.id, { note: "merged, but neither the task nor its role exists to fold the notes in" });
    try {
      a = spawnInstance(role.id, { label: `Memory: ${repo.name}${d.pr_number ? ` #${d.pr_number}` : ""}`, createdBy: "owner" });
      run(`UPDATE memory_drafts SET instance_id = ? WHERE id = ?`, a.id, d.id);
      const from = draftDir(repo.name, d.instance_id), to = draftDir(repo.name, a.id);
      if (exists(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
      d = get<Draft>(`SELECT * FROM memory_drafts WHERE id = ?`, d.id)!;
    } catch (e: any) {
      return setDraft(d.id, { note: `merged; couldn't start an agent to fold the notes in: ${e.message}` });
    }
  }
  const threadId = dmThreadOf(a.id);
  if (!threadId) return d;
  const out = setDraft(d.id, { status: "promoting", note: null });
  enqueueTask({
    agentId: a.id, threadId, source: "message", title: `Memory: fold in notes from ${d.pr_number ? `PR #${d.pr_number}` : d.branch}`.slice(0, 120),
    prompt: promotionPrompt(repo, out),
    input: { author: "system", content: `${d.pr_number ? `PR #${d.pr_number}` : d.branch} merged into ${repo.default_branch}: fold the task's notes into ${repo.name}'s memory.` },
  });
  return out;
}

/** memory_promoted: the drafts are folded in (or weren't worth keeping). */
export function finishPromotion(agent: Agent, repoName: unknown): string {
  const repo = getRepo(String(repoName ?? "").trim());
  if (!repo) throw new Error(`No repo called "${repoName}"`);
  const d = draftOf(repo.id, agent.id);
  if (!d || d.status !== "promoting") throw new Error(`You have no merged notes to fold into ${repo.name}`);
  try { fs.rmSync(draftDir(repo.name, agent.id), { recursive: true, force: true }); } catch { /* gone */ }
  setDraft(d.id, { status: "promoted", note: null });
  return `Done: your drafts for ${repo.name} are removed; the tree has what you kept.`;
}

// --- the instruction layer --------------------------------------------------------------------------------

/** Repo memory, for a task: where each repo's tree is, its own draft folders, and how the tree works. */
export function memoryLayer(agent: Agent): string {
  if (!agent.base_agent_id) return "";
  const repos = listRepos({ archived: false }).filter((r) => r.status === "ready" && roleAllowed(r, agent));
  if (!repos.length) return "";
  const drafts = ensureDrafts(agent).filter((d) => d.status === "open" || d.status === "promoting");
  const trees = repos.map((r) => {
    const dir = repoMemoryDir(r.name);
    const n = listNotes(dir).length;
    const stale = get<{ stale: number }>(`SELECT stale FROM memory_scans WHERE repo_id = ?`, r.id)?.stale ?? 0;
    return `- **${r.name}**: ${dir}/ ${n ? `(${n} note${n === 1 ? "" : "s"}${stale ? `, ${stale} marked stale` : ""}; start with INDEX.md)` : "(empty so far)"}`;
  });
  const mine = drafts.map((d) => {
    const r = getRepoById(d.repo_id)!;
    return `- ${r.name}: ${draftDir(r.name, agent.id)}/${d.status === "promoting" ? " (merged: fold these in now)" : ""}`;
  });
  return `## Repo memory
What agents learned about each repo, as a tree of short notes that you and the other agents organise (you
choose the folders, names and layout). Look before you explore: read INDEX.md, then only the folders and
notes your task needs. You can read it any time, at the start or in the middle of a task.
${trees.join("\n")}

- **Stale notes:** a note with \`stale:\` in its header describes code that changed on the default branch since it
  was verified. Re-check it against the code before relying on it; if your task depends on it, fix it
  (memory_write with its rev). That's how notes stay true; don't sweep notes your task doesn't need.
- **Be specific:** when the memory shows several variants (three portals with three auth setups), name the one you
  mean, and ask whoever gave you the task when it's ambiguous which one they mean.
- **New knowledge lands when work merges** to the default branch. While you work, write what you learn as notes in
  this task's draft folder (plain files, yours; mirror the tree's paths where you can). When your PR merges you'll
  be asked to fold them in. Only what the code can't tell quickly: decisions and why, gotchas, where things live,
  conventions, dead code to avoid. Not restatements of code.
- **Anchors:** a note that describes code lists it in its frontmatter (\`anchors:\` with \`path/in/repo\` or
  \`path/in/repo#symbol\`); agentbox hashes them and marks the note stale when that code changes.
- **Writing the tree:** it's read-only to file tools and shell writes. Use mcp__team__memory_write (an existing note
  needs the \`rev\` from its header), memory_move and memory_delete. Reuse existing folders and names before making
  new ones, and keep each folder's INDEX.md current (one line per note or subfolder).${mine.length ? `\n\nThis task's draft folders:\n${mine.join("\n")}` : ""}`;
}

// --- background ---------------------------------------------------------------------------------------------

/** Draft folders written in a turn that never came back for another (no row yet): track them. */
function adoptDrafts() {
  for (const repo of listRepos({ archived: false })) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(inside(draftsRoot(), repo.name)); } catch { continue; }
    for (const w of all<{ instance_id: string; repo_id: string; branch: string | null; purpose: string }>(`SELECT instance_id, repo_id, branch, purpose FROM repo_worktrees WHERE repo_id = ?`, repo.id)) {
      if (w.purpose === "onboard" || !dirs.includes(shortId(w.instance_id)) || draftOf(repo.id, w.instance_id)) continue;
      const a = getAgent(w.instance_id);
      run(`INSERT INTO memory_drafts (id, repo_id, instance_id, role_id, branch, watch_branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        newId(), repo.id, w.instance_id, a?.base_agent_id ?? null, w.branch, w.branch, a?.created_at ?? now(), now());
    }
  }
}

/** One pass: re-hash notes where main moved; follow open drafts. */
export async function memoryTick() {
  adoptDrafts();
  const scans: Record<string, unknown> = {};
  for (const repo of listRepos({ archived: false }).filter((r) => r.status === "ready")) {
    try { const s = await scanRepo(repo); if (s) scans[repo.name] = s; } catch (e: any) { scans[repo.name] = { error: e.message }; }
  }
  const drafts: Draft[] = [];
  for (const d of all<Draft>(`SELECT * FROM memory_drafts WHERE status = 'open'`)) {
    try { drafts.push(await checkDraft(d)); } catch { /* next time */ }
  }
  return { scans, drafts };
}

let timer: NodeJS.Timeout | null = null;
export function startMemory(opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  fs.mkdirSync(memoryRoot(), { recursive: true });
  fs.mkdirSync(draftsRoot(), { recursive: true });
  const ms = Number(process.env.AGENTBOX_MEMORY_MS ?? 10 * 60_000);
  const tick = () => void memoryTick().then((r) => { if (Object.keys(r.scans).length) log(`memory: ${JSON.stringify(r.scans)}`); }).catch(() => {});
  if (timer) clearInterval(timer);
  timer = setInterval(tick, ms);
  timer.unref();
  setTimeout(tick, 60_000).unref();
  return { stop: () => { if (timer) clearInterval(timer); timer = null; } };
}

// --- views ----------------------------------------------------------------------------------------------------

/** A repo's memory at a glance (the Repos page): notes, stale ones, drafts waiting for a merge. */
export function memoryOf(r: Repo) {
  const dir = repoMemoryDir(r.name);
  const scan = get<{ head: string; scanned_at: string; stale: number }>(`SELECT * FROM memory_scans WHERE repo_id = ?`, r.id);
  const index = path.join(dir, "INDEX.md");
  return {
    repo: r.name, dir, index: exists(index) ? index : null, notes: listNotes(dir).length, stale: scan?.stale ?? 0, scanned_at: scan?.scanned_at ?? null, head: scan?.head ?? null,
    drafts: all<Draft>(`SELECT * FROM memory_drafts WHERE repo_id = ? AND status IN ('open', 'promoting') ORDER BY created_at DESC`, r.id).map(draftView).filter((d) => d.notes > 0 || d.status === "promoting"),
  };
}

export const memorySummary = () => listRepos({ archived: false }).map(memoryOf);

export function registerMemoryRoutes(app: FastifyInstance) {
  app.get("/api/memory", async () => ({ repos: memorySummary() }));
  app.post("/api/memory/check", async () => {
    const r = await memoryTick();
    return { scans: r.scans, repos: memorySummary() };
  });
}
