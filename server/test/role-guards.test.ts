/**
 * Role guards (docs/V2.1-PLAN.md §4): integration CLIs only for the roles mapped to them, and no
 * hands-on work for orchestrators. In-process against a throwaway database.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/role-guards.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-guards-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\nmodules: { aws: true, kubernetes: true, github: true }\n`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", NO_COLOR: "1",
});

const { run } = await import("../src/db.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const G = await import("../src/roleGuards.ts");
const R = await import("../src/repos.ts");
const RU = await import("../src/runner.ts");
const S = await import("../src/setup.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (name: string, scale = false) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  if (scale) run(`UPDATE agents SET can_scale = 1 WHERE id = ?`, a.id);
  return A.getAgent(a.id)!;
};
const lead = mk("tech-lead", true);
const coder = mk("coder");
const devops = mk("devops");
const map = (integration: string, ...roles: { id: string }[]) => {
  for (const r of roles) run(`INSERT INTO role_integrations (role_id, integration_id) VALUES (?, ?)`, r.id, integration);
};
map("github", lead, coder, devops);
map("aws", devops);
map("kubernetes", devops);
const task = (role: { id: string }, label: string) => A.spawnInstance(role.id, { label, createdBy: "owner", asLead: true });
const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === "deny";
const bash = (command: string, cwd = "/") => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });

test("the modules declare their CLIs", () => {
  const owners = G.commandOwners();
  assert.equal(owners.get("aws"), "aws");
  assert.equal(owners.get("kubectl"), "kubernetes");
  assert.equal(owners.get("helm"), "kubernetes");
  assert.equal(owners.get("gh"), "github");
  assert.equal(owners.get("gcloud"), "gcp");
});

test("invokes: command position only, through wrappers, paths, pipes and bash -c", () => {
  const yes = [
    "kubectl get pods", "  kubectl --context x get ns", "cd /tmp && kubectl get ns", "echo hi; kubectl version", "x | kubectl apply -f -",
    "sudo kubectl get ns", "env KUBECONFIG=/x kubectl get ns", "AWS_PROFILE=p aws s3 ls", "timeout 60 kubectl get ns", "/usr/local/bin/kubectl get ns",
    "bash -c 'kubectl get ns'", 'sh -c "aws sts get-caller-identity"', "echo $(aws sts get-caller-identity)", "xargs kubectl delete pod", "(kubectl get ns)",
  ];
  for (const c of yes) assert.ok(G.invokes(c, c.includes("aws") ? "aws" : "kubectl"), c);
  const no = ["grep -r kubectl docs/", "cat notes/aws.md", "echo kubectl is great", "ls ~/.aws", "kubectl-neat x", "rg 'aws s3' src", "git log --grep aws"];
  for (const c of no) assert.ok(!G.invokes(c, c.includes("aws") ? "aws" : "kubectl"), c);
});

test("integrationGuard: unmapped roles are refused and pointed at who has it; mapped roles and the setup agent aren't", async () => {
  const t = task(lead, "Explore infra");
  const g = G.integrationGuard(t);
  let r = await g(bash("kubectl --context brandsek-prod get ingress -A"));
  assert.ok(denied(r));
  r = await g(bash("aws elbv2 describe-load-balancers"));
  assert.ok(denied(r));
  assert.ok(!denied(await g(bash("gh pr list"))), "github is the lead's");
  assert.ok(!denied(await g(bash("grep -rn kubectl docs/"))), "reading about it is fine");
  assert.ok(!denied(await G.integrationGuard(task(devops, "Infra"))(bash("kubectl get ns && aws sts get-caller-identity"))));
  const st = A.spawnInstance(S.ensureSetupRole().id, { label: "Setup", createdBy: "owner" });
  assert.ok(!denied(await G.integrationGuard(st)(bash("aws configure list"))), "the setup agent sets integrations up");
  const c = task(coder, "Code");
  assert.ok(denied(await G.integrationGuard(c)(bash("bash -c 'helm list -A'"))));
  // The message: delegate, to whom. (Connected or not decides the wording; both name the way out.)
  const why = (await g(bash("kubectl get ns"))).hookSpecificOutput.permissionDecisionReason;
  assert.match(why, /isn't one of your tools; it's devops's|no agent of yours has/);
});

test("orchestratorGuard: no edits or commits in repos for plan-and-delegate roles; reading, notes and PR merges are fine", async () => {
  const t = task(lead, "Lead work");
  const g = G.orchestratorGuard(t);
  const wt = path.join(R.worktreesRoot(), "web", "abcd1234");
  const edit = (file_path: string) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path }, cwd: wt });
  assert.ok(denied(await g(edit(path.join(wt, "src/app.ts")))));
  assert.ok(denied(await g(edit("src/app.ts"))), "relative to a worktree cwd");
  assert.ok(!denied(await g(edit(path.join(A.homeOf(t), "docs", "plan.md")))), "its own docs");
  assert.ok(!denied(await g(edit(path.join(dirs.work, "rooms", "x", "state.md")))), "the work's shared notes");
  assert.ok(denied(await g(bash("git commit -am wip", wt))));
  assert.ok(denied(await g(bash("git -C /x merge origin/main"))));
  assert.ok(denied(await g(bash("git rebase origin/main"))));
  assert.ok(denied(await g(bash(`cat > ${wt}/src/new.ts <<'EOF'\nx\nEOF`))));
  assert.ok(denied(await g(bash("sed -i s/a/b/ src/app.ts", wt))), "writing from inside a worktree");
  assert.ok(!denied(await g(bash("git log --oneline -5 && git diff origin/main...HEAD", wt))));
  assert.ok(!denied(await g(bash("npm test 2>&1 | tail -20", wt))), "running checks to review is fine");
  assert.ok(!denied(await g(bash("gh pr merge 12 --squash --delete-branch"))));
  assert.ok(!denied(await g(bash("gh pr review 12 --comment -b 'x'"))));
  // Not an orchestrator: no limits from this guard.
  assert.ok(!denied(await G.orchestratorGuard(task(coder, "Impl"))(bash("git commit -am fix", wt))));
});

test("instructions: orchestrators are told their lane; everyone gets the stay-in-your-lane rule and the roster's tools", () => {
  const t = task(lead, "Plan");
  const p = RU.instructionLayers(t).find((l) => l.id === "platform")!.text;
  assert.match(p, /You orchestrate; you don't do hands-on work/);
  assert.match(p, /simplest\nelegant solution/);
  assert.match(p, /Stay in your lane/);
  const c = RU.instructionLayers(task(coder, "Impl")).find((l) => l.id === "platform")!.text;
  assert.ok(!/You orchestrate/.test(c));
  assert.match(c, /Stay in your lane/);
});

test("the setup agent isn't a teammate: not listed, not delegated to (setup requests are the way)", async () => {
  const TM = await import("../src/team.ts");
  const { newId, now } = await import("../src/db.ts");
  S.ensureSetupRole();
  const t = task(lead, "Needs access");
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`, id, t.id, A.dmThreadOf(t.id), now());
  const tools = TM.teamTools(t, id);
  const call = (name: string, args: any) => (tools.find((x: any) => x.name === name) as any).handler(args, {});
  const list = await call("list_agents", {});
  assert.ok(!/setup/i.test(list.content[0].text), list.content[0].text);
  const d = await call("delegate_task", { to: "setup", title: "Connect GCP", instructions: "please" });
  assert.ok(d.isError);
  assert.match(d.content[0].text, /request_setup/);
  assert.ok(!/setup/.test(TM.rosterFor(t)));
});

test("orchestrators create the roadmap before they delegate; others don't need one", async () => {
  const TM = await import("../src/team.ts");
  const RM = await import("../src/roadmaps.ts");
  const { newId, now } = await import("../src/db.ts");
  const turn = (a: { id: string }) => {
    const id = newId();
    run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`, id, a.id, A.dmThreadOf(a.id), now());
    return id;
  };
  const t = task(lead, "Big work");
  const tools = TM.teamTools(t, turn(t));
  const call = (name: string, args: any) => (tools.find((x: any) => x.name === name) as any).handler(args, {});
  let d = await call("delegate_task", { to: "coder", title: "Build it", instructions: "x" });
  assert.ok(d.isError);
  assert.match(d.content[0].text, /roadmap first/);
  RM.createRoadmap(t, null, { title: "Big work", items: [{ id: "build", title: "Build it", owner: "coder" }] });
  d = await call("delegate_task", { to: "coder", title: "Build it", instructions: "x" });
  assert.ok(!d.isError, d.content[0].text);
  // A coder handing a piece to devops needs no roadmap of its own.
  const c = task(coder, "Solo");
  const ct = TM.teamTools(c, turn(c));
  const r = await (ct.find((x: any) => x.name === "delegate_task") as any).handler({ to: "devops", title: "Check CI", instructions: "x" }, {});
  assert.ok(!r.isError, r.content[0].text);
  assert.match(RU.instructionLayers(t).find((l) => l.id === "platform")!.text, /Before your first delegation, create the work's roadmap/);
});
