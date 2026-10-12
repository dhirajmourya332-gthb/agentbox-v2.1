/**
 * Repo memory (docs/TREE-MEMORY.md): agent-owned note trees per repo, draft notes per task folded in when
 * the work merges to main, anchors hashed and marked stale by a plain program when main moves, writes
 * serialized with revs, the tree read-only to file tools. In-process against a throwaway database; the
 * "remote" is a local bare repo reached through a temp global git config. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/memory.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-memory-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations", "remotes", "scratch", "bin"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const gitconfig = path.join(tmp, "gitconfig");
fs.writeFileSync(gitconfig, `[user]\n\tname = Test\n\temail = test@example.test\n[init]\n\tdefaultBranch = main\n[url "${dirs.remotes}/"]\n\tinsteadOf = https://example.test/\n[url "${dirs.remotes}/"]\n\tinsteadOf = https://github.com/\n[uploadpack]\n\tallowFilter = true\n[protocol "file"]\n\tallow = always\n`);
// A fake gh: `pr list` prints $FAKE_GH_PRS (a JSON array).
const fakeGh = path.join(dirs.bin, "gh");
fs.writeFileSync(fakeGh, `#!/bin/sh\ncase "$1 $2" in\n  "pr list") cat "$FAKE_GH_PRS" ;;\n  *) echo '[]' ;;\nesac\n`, { mode: 0o755 });
const prsFile = path.join(tmp, "prs.json");
fs.writeFileSync(prsFile, "[]");
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\n`);
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", AGENTBOX_GH: fakeGh, FAKE_GH_PRS: prsFile,
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", AGENTBOX_REPO_FETCH_MS: "3600000", NO_COLOR: "1",
});

const sh = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};

const AUTH_V1 = `import { jwt } from "./jwt";

export function refreshToken(token: string) {
  const next = jwt.rotate(token);
  return next;
}

export function logout() {
  return null;
}
`;

/** The "remote": portal-a with an auth module. */
const bare = path.join(dirs.remotes, "acme", "portals.git");
sh("git", ["init", "--bare", "-q", "-b", "main", bare]);
const seed = path.join(dirs.scratch, "seed");
sh("git", ["clone", "-q", bare, seed]);
fs.mkdirSync(path.join(seed, "portal-a"), { recursive: true });
fs.writeFileSync(path.join(seed, "portal-a", "auth.ts"), AUTH_V1);
fs.writeFileSync(path.join(seed, "README.md"), "# portals\n");
sh("git", ["add", "."], seed);
sh("git", ["commit", "-q", "-m", "init"], seed);
sh("git", ["push", "-q", "origin", "HEAD:main"], seed);
const commit = (file: string, text: string, msg: string) => {
  sh("git", ["pull", "-q", "--rebase", "origin", "main"], seed);
  fs.writeFileSync(path.join(seed, file), text);
  sh("git", ["commit", "-q", "-am", msg], seed);
  sh("git", ["push", "-q", "origin", "HEAD:main"], seed);
  return sh("git", ["rev-parse", "HEAD"], seed);
};

const { run, get, all } = await import("../src/db.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true); // nothing runs Claude
const A = await import("../src/agents.ts");
const R = await import("../src/repos.ts");
const G = await import("../src/repoGuard.ts");
const M = await import("../src/memory.ts");
const RU = await import("../src/runner.ts");
const TM = await import("../src/team.ts");

const background = R.startRepos({ log: () => {} });
after(() => { background.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name: string) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  return A.getAgent(a.id)!;
};
const coder = mk("coder");
const devops = mk("devops");
const task = (roleId: string, label: string) => A.spawnInstance(roleId, { label, createdBy: "owner", asLead: true });
const waitFor = async (fn: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 50)); }
};
const call = async (agent: any, name: string, args: any) => {
  const t = TM.teamTools(agent, null as any).find((x: any) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};
const out = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

const added = R.addRepo({ url: "https://example.test/acme/portals.git" } as any, { onboard: () => {} });
await waitFor(() => R.getRepo(added.name)!.status !== "cloning");
const repo = R.getRepo(added.name)!;
assert.equal(repo.status, "ready");
const canon = R.clonePath(repo.name);
const tree = M.repoMemoryDir(repo.name);
const fetchNow = () => R.fetchRepo(repo.name);
const draftRow = (instanceId: string) => get<any>(`SELECT * FROM memory_drafts WHERE instance_id = ?`, instanceId);

test("anchors: a symbol's block hashes the same after edits elsewhere or reformatting, differently when it changes", () => {
  const block = M.symbolBlock(AUTH_V1, "refreshToken")!;
  assert.match(block, /^export function refreshToken/);
  assert.match(block, /return next;\n}$/);
  assert.ok(!block.includes("logout"));
  assert.equal(M.symbolBlock(AUTH_V1, "nope"), null);
  // Members and Python-style blocks.
  assert.match(M.symbolBlock("class A {\n  async save(x) {\n    go(x);\n  }\n  other() {}\n}\n", "save")!, /async save[\s\S]*go\(x\);\n  }$/);
  assert.equal(M.symbolBlock("def load(p):\n    return open(p)\n\ndef other():\n    pass\n", "load"), "def load(p):\n    return open(p)");
  assert.deepEqual(M.parseAnchor("portal-a/auth.ts#refreshToken @abcdef123456"), { file: "portal-a/auth.ts", symbol: "refreshToken", hash: "abcdef123456" });
  assert.throws(() => M.parseAnchor("../etc/passwd"), /inside the repo/);
});

test("paths: agents choose names, but inside the tree, plain segments, .md", () => {
  assert.equal(M.notePath("portal-a/auth.md"), "portal-a/auth.md");
  assert.equal(M.notePath("./portal-b/Payments_v2.md"), "portal-b/Payments_v2.md");
  for (const bad of ["../x.md", "a/../../x.md", ".hidden/x.md", "a/x.txt", "", "a b/x.md", "/etc/x.md"]) {
    assert.throws(() => M.notePath(bad), Error, bad);
  }
  // A full path inside the repo's tree is accepted.
  assert.equal(M.notePath(path.join(M.repoMemoryDir("portals"), "portal-a", "auth.md"), { repo: "portals" }), "portal-a/auth.md");
  assert.throws(() => M.notePath(path.join(M.repoMemoryDir("other"), "x.md"), { repo: "portals" }), /outside/);
});

let fix: any, draftsDir: string;
test("layer: every task sees the trees it may use and its own draft folder; how memory works", async () => {
  fix = task(coder.id, "Fix portal-a token refresh");
  await R.ensureWorktree(fix, repo.name);
  const layer = RU.instructionLayers(fix).find((l) => l.id === "repos")!.text;
  assert.match(layer, /## Repo memory/);
  assert.ok(layer.includes(tree), "the tree's path");
  assert.match(layer, /empty so far/);
  draftsDir = M.draftDir(repo.name, fix.id);
  assert.ok(layer.includes(draftsDir), "its draft folder");
  assert.match(layer, /stale:/);
  assert.match(layer, /name the one you\s+mean/);
  assert.equal(draftRow(fix.id).status, "open");
  // A task that hasn't picked a repo yet still knows where its drafts for each repo go.
  const fresh = task(coder.id, "Not bound yet");
  assert.ok(RU.instructionLayers(fresh).find((l) => l.id === "repos")!.text.includes(M.draftDir(repo.name, fresh.id)));
  // use_repo mid-turn: the result names the tree and the draft folder, and the draft is tracked right away.
  const r = await call(fresh, "use_repo", { name: repo.name });
  assert.ok(out(r).includes(M.draftDir(repo.name, fresh.id)) && out(r).includes(tree), out(r));
  assert.equal(draftRow(fresh.id)?.status, "open");
  // Roles (not tasks) get no memory section.
  assert.ok(!RU.instructionLayers(coder).find((l) => l.id === "repos")!.text.includes("Repo memory"));
});

test("guard: the tree is read-only to file tools and shell writes; drafts are the agent's", async () => {
  const v = (tool: string, input: any, cwd?: string) => G.repoViolation(fix, tool, input, cwd);
  fs.mkdirSync(tree, { recursive: true });
  assert.match((await v("Write", { file_path: path.join(tree, "portal-a", "auth.md") }))!, /memory_write/);
  assert.match((await v("Edit", { file_path: "INDEX.md" }, tree))!, /memory_write/);
  for (const bad of [`echo x > ${tree}/a.md`, `rm -rf ${tree}/portal-a`, `mv ${tree}/a.md ${tree}/b.md`, `sed -i s/a/b/ ${tree}/INDEX.md`]) {
    assert.ok(await v("Bash", { command: bad }), bad);
  }
  for (const okCmd of [`cat ${tree}/INDEX.md`, `grep -rn stale: ${tree}`, `ls -R ${tree}`, `find ${tree} -name '*.md'`]) {
    assert.equal(await v("Bash", { command: okCmd }), null, okCmd);
  }
  assert.equal(await v("Write", { file_path: path.join(draftsDir, "portal-a", "auth.md") }), null);
  assert.equal(await v("Bash", { command: `mkdir -p ${draftsDir} && echo x > ${draftsDir}/n.md` }), null);
});

test("writes: new notes only when merged work is folded in; drafts meanwhile", async () => {
  const r = await call(fix, "memory_write", { repo: repo.name, path: "portal-a/auth.md", content: "# Auth\nKeycloak.\n" });
  assert.equal(r.isError, true);
  assert.ok(out(r).includes(draftsDir), "points at the draft folder");
  assert.ok(!fs.existsSync(path.join(tree, "portal-a", "auth.md")));
});

let mergeSha: string;
test("merge to main: the task's drafts are folded in by the agent that did the work, then removed", async () => {
  // The agent writes drafts and commits on its branch.
  fs.mkdirSync(path.join(draftsDir, "portal-a"), { recursive: true });
  fs.writeFileSync(path.join(draftsDir, "portal-a", "auth.md"), "Keycloak; refresh rotates the token.\n");
  const wt = R.worktreesFor(fix.id)[0];
  fs.writeFileSync(path.join(wt.path!, "portal-a", "auth.ts"), AUTH_V1.replace("return next;", "audit(next);\n  return next;"));
  sh("git", ["commit", "-q", "-am", "rotate audit"], wt.path!);
  sh("git", ["push", "-q", "-u", "origin", "HEAD"], wt.path!);
  // Not merged yet: nothing happens.
  await fetchNow();
  assert.equal((await M.checkDraft(draftRow(fix.id))).status, "open");
  // Merged (fast-forward) into main.
  sh("git", ["fetch", "-q", "origin"], seed);
  sh("git", ["merge", "-q", "--ff-only", `origin/${wt.branch}`], seed);
  sh("git", ["push", "-q", "origin", "HEAD:main"], seed);
  mergeSha = sh("git", ["rev-parse", "HEAD"], seed);
  await fetchNow();
  const d = await M.checkDraft(draftRow(fix.id));
  assert.equal(d.status, "promoting");
  const queued = all<any>(`SELECT * FROM tasks WHERE agent_id = ? AND status = 'queued'`, fix.id);
  assert.equal(queued.length, 1);
  assert.match(queued[0].prompt, /merged into main/);
  assert.ok(queued[0].prompt.includes(draftsDir) && queued[0].prompt.includes(tree));
  assert.match(queued[0].prompt, /memory_promoted/);
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, queued[0].id);

  // Folding in: the agent creates notes (its own names and layout), anchored to main.
  let r = await call(fix, "memory_write", {
    repo: repo.name, path: "portal-a/auth.md",
    content: "---\ntitle: Portal A auth\nanchors:\n  - portal-a/auth.ts#refreshToken\n---\n# Portal A auth\nKeycloak. refreshToken rotates and audits the token; never cache it.\n",
  });
  assert.ok(!r.isError, out(r));
  assert.match(out(r), /rev 1; anchored to 1 place/);
  assert.match(out(r), /portal-a\/INDEX\.md doesn't list it yet/);
  const note = M.parseNote(fs.readFileSync(path.join(tree, "portal-a", "auth.md"), "utf8"));
  assert.equal(note.rev, 1);
  assert.equal(note.meta.title, "Portal A auth", "the agent's own fields are kept");
  assert.match(String(note.meta.verified), new RegExp(`^${mergeSha.slice(0, 12)} `));
  assert.match(note.anchors[0].hash!, /^[0-9a-f]{12}$/);
  r = await call(fix, "memory_write", { repo: repo.name, path: "portal-a/INDEX.md", content: "# portal-a\n- auth.md — Keycloak, token refresh\n" });
  assert.ok(!r.isError, out(r));
  r = await call(fix, "memory_write", { repo: repo.name, path: "INDEX.md", content: "# portals\n- portal-a/ — Keycloak auth\n" });
  assert.ok(!r.isError, out(r));
  // An anchor that isn't on main is refused.
  r = await call(fix, "memory_write", { repo: repo.name, path: "portal-a/nope.md", content: "---\nanchors: [portal-a/auth.ts#missingFn]\n---\nx\n" });
  assert.equal(r.isError, true);
  assert.match(out(r), /Not on origin\/main/);

  r = await call(fix, "memory_promoted", { repo: repo.name });
  assert.ok(!r.isError, out(r));
  assert.equal(draftRow(fix.id).status, "promoted");
  assert.ok(!fs.existsSync(draftsDir), "drafts removed");
  // Done folding in: new notes are refused again.
  r = await call(fix, "memory_write", { repo: repo.name, path: "portal-a/other.md", content: "x\n" });
  assert.equal(r.isError, true);
});

test("revs: an update must name the current rev; a stale read is refused; another agent may fix a note", async () => {
  const other = task(devops.id, "Check auth config");
  const rel = "portal-a/auth.md";
  let r = await call(other, "memory_write", { repo: repo.name, path: rel, content: "# Portal A auth\nchanged\n" });
  assert.equal(r.isError, true);
  assert.match(out(r), /pass rev 1/);
  r = await call(other, "memory_write", { repo: repo.name, path: rel, rev: 0, content: "# x\n" });
  assert.match(out(r), /changed since you read it/);
  const cur = fs.readFileSync(path.join(tree, rel), "utf8");
  r = await call(other, "memory_write", { repo: repo.name, path: rel, rev: 1, content: cur.replace("never cache it.", "never cache it. Sessions last 30 min.") });
  assert.ok(!r.isError, out(r));
  const n = M.parseNote(fs.readFileSync(path.join(tree, rel), "utf8"));
  assert.equal(n.rev, 2);
  assert.match(String(n.meta.verified), /by devops#/);
  // Two writers racing on the same rev: one wins, the other is told to re-read.
  const body = fs.readFileSync(path.join(tree, rel), "utf8");
  const [a, b] = await Promise.all([
    call(fix, "memory_write", { repo: repo.name, path: rel, rev: 2, content: body + "\nA\n" }),
    call(other, "memory_write", { repo: repo.name, path: rel, rev: 2, content: body + "\nB\n" }),
  ]);
  assert.equal([a, b].filter((x) => x.isError).length, 1);
  assert.equal(M.parseNote(fs.readFileSync(path.join(tree, rel), "utf8")).rev, 3);
});

test("staleness: no tokens; an edit elsewhere in the file or reformatting doesn't mark it; a change to the symbol does; a revert clears it", async () => {
  const rel = path.join(tree, "portal-a", "auth.md");
  const scan = async () => { await fetchNow(); return M.scanRepo(R.getRepo(repo.name)!); };
  await M.scanRepo(R.getRepo(repo.name)!, { force: true });
  // Unrelated function and whitespace changes.
  const base = sh("git", ["show", "origin/main:portal-a/auth.ts"], canon);
  commit("portal-a/auth.ts", base.replace("return null;", "return undefined;").replace("  const next", "    const next") + "\n\n", "logout tweak + reindent");
  let s = await scan();
  assert.equal(s?.stale, 0);
  assert.equal(M.parseNote(fs.readFileSync(rel, "utf8")).stale, null);
  // The anchored function changes.
  const before = sh("git", ["show", "origin/main:portal-a/auth.ts"], canon);
  const sha = commit("portal-a/auth.ts", before.replace("jwt.rotate(token)", "jwt.rotate(token, { ttl: 60 })"), "shorter ttl");
  s = await scan();
  assert.equal(s?.stale, 1);
  const n = M.parseNote(fs.readFileSync(rel, "utf8"));
  assert.match(n.stale!, /portal-a\/auth\.ts#refreshToken changed on main/);
  assert.ok(n.stale!.includes(sha.slice(0, 7)), "names the commit");
  assert.equal(n.rev, 3, "marking doesn't bump the rev");
  // Same head again: nothing to do.
  assert.equal(await M.scanRepo(R.getRepo(repo.name)!), null);
  // The layer counts it.
  assert.match(RU.instructionLayers(fix).find((l) => l.id === "repos")!.text, /1 marked stale/);
  // Reverted: cleared.
  commit("portal-a/auth.ts", before, "revert ttl");
  s = await scan();
  assert.equal(s?.stale, 0);
  assert.equal(M.parseNote(fs.readFileSync(rel, "utf8")).stale, null);
  // Changed again, then an agent re-verifies (rewrites with the rev): anchored at the new head, stale gone.
  commit("portal-a/auth.ts", before.replace("jwt.rotate(token)", "jwt.rotate(token, { ttl: 90 })"), "ttl 90");
  await scan();
  const st = M.parseNote(fs.readFileSync(rel, "utf8"));
  assert.ok(st.stale);
  const r = await call(fix, "memory_write", { repo: repo.name, path: "portal-a/auth.md", rev: st.rev, content: "---\nanchors: [portal-a/auth.ts#refreshToken]\n---\n# Portal A auth\nTokens rotate with a 90s ttl.\n" });
  assert.ok(!r.isError, out(r));
  const fresh = M.parseNote(fs.readFileSync(rel, "utf8"));
  assert.equal(fresh.stale, null);
  assert.equal(fresh.rev, st.rev + 1);
  assert.equal((await M.scanRepo(R.getRepo(repo.name)!, { force: true }))?.stale, 0);
});

test("reorganise: move and delete (the tree is the agents'); paths stay inside", async () => {
  let r = await call(fix, "memory_move", { repo: repo.name, from: "portal-a", to: "portals/portal-a" });
  assert.ok(!r.isError, out(r));
  assert.ok(fs.existsSync(path.join(tree, "portals", "portal-a", "auth.md")));
  assert.ok(!fs.existsSync(path.join(tree, "portal-a")));
  r = await call(fix, "memory_move", { repo: repo.name, from: "portals/portal-a/auth.md", to: "../escape.md" });
  assert.equal(r.isError, true);
  r = await call(fix, "memory_delete", { repo: repo.name, path: "portals/portal-a/INDEX.md" });
  assert.ok(!r.isError, out(r));
  assert.ok(!fs.existsSync(path.join(tree, "portals", "portal-a", "INDEX.md")));
  r = await call(fix, "memory_delete", { repo: repo.name, path: "portals/nope.md" });
  assert.equal(r.isError, true);
});

test("epics: merged into an epic waits; when the epic reaches main (GitHub), the notes are folded in", async () => {
  run(`UPDATE repos SET provider = 'github', url = 'https://github.com/acme/portals.git' WHERE id = ?`, repo.id);
  const t = task(coder.id, "Portal-b billing piece");
  const wt = await R.ensureWorktree(t, repo.name);
  RU.instructionLayers(t); // creates its draft row
  const dd = M.draftDir(repo.name, t.id);
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, "billing.md"), "Stripe webhooks are idempotent by event id.\n");
  fs.writeFileSync(prsFile, JSON.stringify([{ number: 7, state: "MERGED", baseRefName: "epic/billing", mergeCommit: { oid: "a".repeat(40) }, url: "https://github.com/acme/portals/pull/7" }]));
  let d = await M.checkDraft(draftRow(t.id));
  assert.equal(d.status, "open");
  assert.equal(d.watch_branch, "epic/billing");
  assert.match(d.note!, /waiting for epic\/billing to reach main/);
  fs.writeFileSync(prsFile, JSON.stringify([{ number: 9, state: "MERGED", baseRefName: "main", mergeCommit: { oid: "b".repeat(40) }, url: "https://github.com/acme/portals/pull/9" }]));
  d = await M.checkDraft(draftRow(t.id));
  assert.equal(d.status, "promoting");
  assert.equal(d.pr_number, 9);
  assert.match(all<any>(`SELECT prompt FROM tasks WHERE agent_id = ? AND status = 'queued'`, t.id)[0].prompt, /PR #9 merged into main \(bbbbbbbbbbbb\)/);
  void wt;
});

test("closed unmerged: drafts discarded once the task is closed; a closed task's merged work revives it to fold in", async () => {
  // Closed without merging.
  const t = task(coder.id, "Abandoned idea");
  await R.ensureWorktree(t, repo.name);
  RU.instructionLayers(t);
  const dd = M.draftDir(repo.name, t.id);
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, "idea.md"), "x\n");
  fs.writeFileSync(prsFile, JSON.stringify([{ number: 11, state: "CLOSED", baseRefName: "main", mergeCommit: null }]));
  assert.equal((await M.checkDraft(draftRow(t.id))).status, "open", "kept while the task is open");
  run(`UPDATE agents SET retired_at = ? WHERE id = ?`, new Date().toISOString(), t.id);
  assert.equal((await M.checkDraft(draftRow(t.id))).status, "discarded");
  assert.ok(!fs.existsSync(dd));

  // Merged after the task was closed: it's revived to fold its notes in.
  const u = task(coder.id, "Done earlier");
  await R.ensureWorktree(u, repo.name);
  RU.instructionLayers(u);
  const ud = M.draftDir(repo.name, u.id);
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, "n.md"), "x\n");
  run(`UPDATE agents SET retired_at = ? WHERE id = ?`, new Date().toISOString(), u.id);
  fs.writeFileSync(prsFile, JSON.stringify([{ number: 12, state: "MERGED", baseRefName: "main", mergeCommit: { oid: "c".repeat(40) } }]));
  assert.equal((await M.checkDraft(draftRow(u.id))).status, "promoting");
  assert.equal(A.getAgent(u.id)!.retired_at, null, "revived");
  // Merged with no notes: nothing to fold in, nobody woken.
  const v = task(coder.id, "No notes");
  await R.ensureWorktree(v, repo.name);
  RU.instructionLayers(v);
  assert.equal((await M.checkDraft(draftRow(v.id))).status, "empty");
  assert.equal(all<any>(`SELECT * FROM tasks WHERE agent_id = ?`, v.id).length, 0);
});

test("summary: per repo notes, stale count and drafts", async () => {
  const s = M.memorySummary().find((x) => x.repo === repo.name)!;
  assert.ok(s.notes >= 2);
  assert.equal(s.dir, tree);
  assert.ok(s.drafts.some((d: any) => d.status === "promoting"));
});
