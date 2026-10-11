import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent } from "./agents.ts";
import { deployWorkflowOf } from "./rules.ts";
import { getRepoById, git, listRepos, reposRoot, urlKey, worktreesFor, type Repo } from "./repos.ts";

/**
 * The repos' PreToolUse rules (docs/V2-ARCHITECTURE.md, Changes (repos)), in the style of rulesGuard:
 * - the canonical clones (<paths.work>/repos/…) are read-only: the edit tools may not write there, and
 *   shell commands that touch them may only read (a whitelist of read-only commands and git
 *   subcommands);
 * - pushes to a repo's protected branches and merges of PRs into them are refused unless the repo
 *   allows agents to merge; deploy workflows are refused unless it allows agents to deploy.
 */

const runFile = promisify(execFile);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const under = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

function realish(p: string) {
  // The file may not exist yet: resolve its nearest existing parent (symlinks included).
  let dir = p;
  const rest: string[] = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { rest.unshift(path.basename(dir)); dir = path.dirname(dir); }
  try { return path.join(fs.realpathSync(dir), ...rest); } catch { return p; }
}

const READ_CMDS = new Set([
  "cd", "pushd", "popd", "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "find", "wc", "file", "stat", "tree",
  "echo", "printf", "pwd", "true", "false", "test", "[", "du", "diff", "cmp", "sort", "uniq", "cut", "awk", "sed", "jq", "basename", "dirname",
  "realpath", "readlink", "which", "nl", "column", "tr", "date", "env", "md5sum", "sha256sum", "git",
]);
const GIT_READ = new Set([
  "log", "show", "diff", "status", "grep", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "blame", "cat-file", "describe",
  "shortlog", "show-ref", "for-each-ref", "fetch", "merge-base", "name-rev", "whatchanged", "count-objects", "help", "version",
]);

/** A git command line's subcommand and its arguments (global options skipped). */
function gitSub(tokens: string[]) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(tokens[i])) i += 2; else i++;
  }
  const ci = tokens.indexOf("-C");
  return { sub: tokens[i] ?? "", args: tokens.slice(i + 1), dirArg: ci > 0 && ci < i ? tokens[ci + 1] ?? null : null };
}

function gitReadOnly(tokens: string[]): boolean {
  const { sub, args } = gitSub(tokens);
  if (GIT_READ.has(sub)) return true;
  const pos = args.filter((a) => !a.startsWith("-"));
  if (sub === "branch") return pos.length === 0 && !args.some((a) => /^(-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--edit-description)/.test(a));
  if (sub === "tag") return pos.length === 0 || args.includes("-l") || args.includes("--list");
  if (sub === "remote") return pos.length === 0 || ["show", "get-url"].includes(pos[0]);
  if (sub === "config") return args.some((a) => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(a));
  if (sub === "worktree" || sub === "stash") return pos[0] === "list" || (sub === "stash" && pos[0] === "show");
  if (sub === "reflog") return pos.length === 0 || pos[0] === "show";
  return false;
}

/** Split a command line into simple commands (on ; && || | and newlines; substitutions too). */
export function segments(command: string): string[][] {
  return command.replace(/\$\(|`|\(|\)/g, ";").split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, "")))
    .map((t) => { let i = 0; while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++; return t.slice(i); })
    .filter((t) => t.length);
}

/** True when every part of the command only reads (no redirects into files, no writers). */
export function readOnlyCommand(command: string): boolean {
  const noNull = command.replace(/\d?>&\d/g, "").replace(/&?\d?>>?\s*\/dev\/null/g, "");
  if (/>/.test(noNull)) return false;
  return segments(command).every((t) => {
    const cmd = path.basename(t[0]);
    if (!READ_CMDS.has(cmd)) return false;
    if (cmd === "git") return gitReadOnly(t);
    if (cmd === "sed") return !t.some((a) => /^-i|^--in-place|^-[a-zA-Z]*i/.test(a) && a !== "-n");
    if (cmd === "find") return !t.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(a));
    if (cmd === "awk") return !/system\s*\(|print\s*>|\|\s*"/.test(command);
    if (cmd === "env") return t.length === 1;
    return true;
  });
}

/** Does a shell command (or its working directory) reach into the canonical clones? */
export function touchesCanonical(command: string, cwd: string | undefined): boolean {
  const root = reposRoot();
  if (cwd && under(path.resolve(cwd), root)) return true;
  return new RegExp(`(^|[\\s'"=:(;&|])${escape(root)}(/|$|[\\s'";)|&])`).test(command);
}

const CANON_MSG = (wt: string[]) =>
  `The canonical clones in ${reposRoot()}/ are read-only (agentbox keeps them fetched; every task works in its own worktree). ` +
  (wt.length ? `Work in your worktree: ${wt.join(", ")}.` : "Call mcp__team__use_repo(name) to get your worktree, then work there.");

// --- protected branches and deploys ---------------------------------------------------------------

/** The registered repo a remote URL, an "owner/repo" (-R) or a PR URL names. */
function repoByKey(key: string | null): Repo | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase().replace(/\.git$/, "");
  const repos = listRepos({ archived: false });
  return repos.find((r) => urlKey(r.url) === k) ?? (k.split("/").length === 2 ? repos.find((r) => urlKey(r.url)?.endsWith(`/${k}`)) : undefined);
}

async function remoteRepo(dir: string, remote = "origin"): Promise<Repo | undefined> {
  if (!fs.existsSync(dir)) return undefined;
  // The configured URL (get-url would apply insteadOf rewrites).
  if (!/^[\w.-]+$/.test(remote)) return undefined;
  const r = await git(["config", "--get", `remote.${remote}.url`], { cwd: dir, timeoutMs: 10_000 });
  return r.code === 0 ? repoByKey(urlKey(r.stdout.trim())) : undefined;
}

async function currentBranch(dir: string) {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

function cmdRepo(command: string): Repo | undefined {
  const url = command.match(/(?:github\.com|gitlab\.com)\/([\w.-]+\/[\w.-]+)\/(?:-\/)?(?:pull|merge_requests)\/\d+/);
  if (url) return repoByKey(url[1]);
  const flag = command.match(/(?:-R|--repo)[\s=]+["']?([\w.-]+\/[\w./-]+)/)?.[1];
  return flag ? repoByKey(flag) : undefined;
}

const boundRepos = (agent: Agent) =>
  worktreesFor(agent.id).filter((w) => ["active", "pending", "kept"].includes(w.status)).map((w) => getRepoById(w.repo_id)).filter((r): r is Repo => !!r && r.status !== "archived");

/** The base of the PR a `gh pr merge` names (run in its directory), or null. */
async function prBaseIn(command: string, dir: string | undefined): Promise<string | null> {
  const t = command.match(/gh\s+pr\s+merge\b(.*)/)?.[1] ?? "";
  const num = t.match(/(?:^|\s)#?(\d+)(?:\s|$)/)?.[1] ?? command.match(/\/pull\/(\d+)/)?.[1];
  const repo = command.match(/(?:-R|--repo)[\s=]+["']?([\w.-]+\/[\w.-]+)/)?.[1] ?? command.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//)?.[1];
  const args = ["pr", "view", ...(num ? [num] : []), ...(repo ? ["-R", repo] : []), "--json", "baseRefName", "-q", ".baseRefName"];
  try {
    const { stdout } = await runFile(process.env.AGENTBOX_GH ?? "gh", args, { timeout: 20_000, cwd: dir && fs.existsSync(dir) ? dir : undefined });
    return stdout.trim() || null;
  } catch { return null; }
}

/** Where a push goes: its destination branches, given the command's tokens after `push`. */
function pushDestinations(args: string[]): { remote: string | null; dests: string[]; all: boolean } {
  const pos: string[] = [];
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all" || a === "--mirror" || a === "--branches") { all = true; continue; }
    if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  const [remote, ...specs] = pos;
  const dests = specs.map((s) => {
    const d = s.replace(/^\+/, "");
    const dst = d.includes(":") ? d.slice(d.indexOf(":") + 1) : d;
    return dst.replace(/^refs\/heads\//, "");
  });
  return { remote: remote ?? null, dests, all };
}

/** Why this tool call breaks a repo rule, or null. */
export async function repoViolation(agent: Agent, tool: string, input: any, cwd?: string): Promise<string | null> {
  const repos = listRepos();
  if (!repos.length) return null;
  const myWorktrees = worktreesFor(agent.id).filter((w) => w.status === "active" && w.path).map((w) => w.path!);

  if (EDIT_TOOLS.has(tool)) {
    const f = String(input?.file_path ?? input?.notebook_path ?? "");
    if (!f) return null;
    const abs = realish(path.resolve(cwd ?? "/", f));
    const root = realish(reposRoot());
    return under(abs, root) || under(path.resolve(cwd ?? "/", f), reposRoot()) ? CANON_MSG(myWorktrees) : null;
  }
  if (tool !== "Bash") return null;
  const command = String(input?.command ?? "");
  if (touchesCanonical(command, cwd) && !readOnlyCommand(command)) return CANON_MSG(myWorktrees);

  // Walk the command, following `cd`, for pushes, merges and deploys.
  let dir = cwd;
  for (const t of segments(command)) {
    const cmd = path.basename(t[0]);
    if (cmd === "cd" && t[1]) { dir = path.resolve(dir ?? "/", t[1].replace(/^~(?=\/|$)/, process.env.HOME ?? "~")); continue; }
    if (cmd === "git") {
      const { sub, args, dirArg } = gitSub(t);
      if (sub !== "push") continue;
      const where = dirArg ? path.resolve(dir ?? "/", dirArg) : dir;
      if (!where) continue;
      const p = pushDestinations(args);
      const repo = await remoteRepo(where, p.remote ?? "origin");
      if (!repo || repo.agents_may_merge) continue;
      const dests = p.dests.length ? await Promise.all(p.dests.map(async (d) => (d === "HEAD" ? await currentBranch(where) ?? d : d))) : [await currentBranch(where) ?? ""];
      if (p.all) return `${repo.name} doesn't let agents push to ${repo.protected_branches.join(", ")}, and --all/--mirror would. Push your own branch only (git push -u origin HEAD).`;
      const hit = dests.find((d) => repo.protected_branches.includes(d));
      if (hit) return `${repo.name}'s branch "${hit}" is protected: agents may not push to it. Push your branch and open a PR; the owner merges.`;
      continue;
    }
    const line = t.join(" ");
    if (cmd === "gh" && t[1] === "pr" && t[2] === "merge") {
      const repo = cmdRepo(line) ?? (dir ? await remoteRepo(dir) : undefined) ?? (boundRepos(agent).length === 1 ? boundRepos(agent)[0] : undefined);
      if (!repo || repo.agents_may_merge) continue;
      const base = await prBaseIn(line, dir);
      if (base === null) return `${repo.name} doesn't let agents merge into ${repo.protected_branches.join(", ")}, and the PR's base couldn't be confirmed. Name it (-R owner/repo <number>) so it can be checked, or leave the merge to the owner.`;
      if (repo.protected_branches.includes(base)) return `${repo.name} doesn't let agents merge into "${base}" (protected). Leave the PR open with your conclusion for the owner.`;
      continue;
    }
    if (cmd === "glab" && t[1] === "mr" && t[2] === "merge") {
      const repo = cmdRepo(line) ?? (dir ? await remoteRepo(dir) : undefined) ?? (boundRepos(agent).length === 1 ? boundRepos(agent)[0] : undefined);
      if (repo && !repo.agents_may_merge) return `${repo.name} doesn't let agents merge. Leave the MR open with your conclusion for the owner.`;
      continue;
    }
    const wf = deployWorkflowOf(line);
    if (wf) {
      const repo = cmdRepo(line) ?? (dir ? await remoteRepo(dir) : undefined);
      const targets = repo ? [repo] : boundRepos(agent);
      const no = targets.find((r) => !r.agents_may_deploy);
      if (no) return `${no.name} doesn't let agents deploy (${wf}). Report what's ready to deploy; the owner deploys.`;
    }
  }
  return null;
}

/** PreToolUse hook: deny edits in canonical clones, protected pushes / merges and deploys. */
export function repoGuard(agent: Agent) {
  return async (input: any) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let why: string | null = null;
    try { why = await repoViolation(agent, String(input.tool_name ?? ""), input.tool_input, input.cwd); } catch { why = null; }
    if (!why) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Blocked by the repo rules: ${why}`,
      },
    };
  };
}
