import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { getAgent, type Agent } from "./agents.ts";
import { isSetupAgent } from "./setup.ts";
import { cachedIntegrations, isConnected, mappedIntegrations, rolesFor } from "./integrations.ts";
import { reposRoot, worktreesRoot } from "./repos.ts";

/**
 * Who does what, enforced (docs/V2.1-PLAN.md §4). Every agent runs as the same unix user, so the
 * credentials of every connected integration (~/.aws, ~/.kube, gh…) are reachable by all of them;
 * the role ↔ integration mapping would otherwise only decide whose instructions mention a tool.
 * - integrationGuard: a CLI that belongs to an integration (module.yaml `commands:`) runs only for
 *   roles mapped to it. Others are told who has it and to delegate. Applies to Claude's built-in
 *   subagents too (their tool calls go through the same hooks). The setup agent is exempt.
 * - orchestratorGuard: roles that plan and delegate ("Plans and delegates", e.g. tech-lead) don't do
 *   hands-on work: no edits inside repo worktrees or clones, and no commits, merges, rebases or
 *   patches. Reading, reviewing, gh issues/PRs/reviews/merges and their own notes stay allowed.
 * These are guardrails for well-meaning agents, not a sandbox: separate unix users would be (H3).
 */

const MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../setup/modules");

let owners: Map<string, string> | null = null;
/** CLI name → integration id, from every module.yaml's `commands:` list. */
export function commandOwners(dir = MODULES): Map<string, string> {
  if (owners && dir === MODULES) return owners;
  const map = new Map<string, string>();
  let ids: string[] = [];
  try { ids = fs.readdirSync(dir); } catch { /* no modules folder (tests) */ }
  for (const id of ids) {
    try {
      const m = parse(fs.readFileSync(path.join(dir, id, "module.yaml"), "utf8"));
      if (m?.kind !== "integration" || !Array.isArray(m.commands)) continue;
      for (const c of m.commands) if (typeof c === "string" && /^[A-Za-z0-9._-]+$/.test(c)) map.set(c, String(m.id ?? id));
    } catch { /* unreadable module: skip */ }
  }
  if (dir === MODULES) owners = map;
  return map;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Does this shell command run `cmd`? In command position: at the start, after ; & | ( ` $( or the quote
 * of a shell script (bash -c "…", eval '…'), after wrappers (sudo, env, exec, nohup, time, timeout N, watch, xargs, command, nice),
 * after VAR=value assignments, and by path (/usr/local/bin/kubectl). Not when it's only an argument
 * (grep kubectl docs/).
 */
export function invokes(command: string, cmd: string): boolean {
  const wrapper = String.raw`(?:(?:sudo|env|exec|nohup|time|watch|xargs|command|nice|stdbuf|timeout(?:\s+-\S+)*\s+\S+)(?:\s+-\S+)*\s+)*`;
  const assigns = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
  // A quote starts a command only as a shell's script: bash -c '…', sh -c "…", eval "…" (not rg 'aws s3').
  const re = new RegExp(String.raw`(?:^|[;&|(\x60\n]|\$\(|(?:\s-c|\beval)\s+['"])\s*${assigns}${wrapper}${assigns}(?:\S*/)?${esc(cmd)}(?=\s|$|[;&|)\x60'"])`, "m");
  return re.test(command);
}

const deny = (why: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why },
});

const titleOf = (id: string) => cachedIntegrations()?.find((x) => x.id === id)?.title ?? id;
const holders = (id: string) => rolesFor(id).map((r) => getAgent(r)).filter((a): a is Agent => !!a && !a.retired_at).map((a) => a.name);

/** Which integration this command needs that the agent's role isn't given (null: none). */
export function missingIntegration(agent: Agent, command: string, map = commandOwners()): { cmd: string; integration: string } | null {
  if (!map.size) return null;
  const mine = new Set(mappedIntegrations(agent.id));
  for (const [cmd, integration] of map) {
    if (mine.has(integration)) continue;
    if (command.includes(cmd) && invokes(command, cmd)) return { cmd, integration };
  }
  return null;
}

export function integrationGuard(agent: Agent) {
  return async (input: any) => {
    if (input?.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash" || isSetupAgent(agent)) return {};
    const hit = missingIntegration(agent, String(input.tool_input?.command ?? ""));
    if (!hit) return {};
    const who = holders(hit.integration);
    const title = titleOf(hit.integration);
    return deny(who.length && isConnected(hit.integration)
      ? `\`${hit.cmd}\` is ${title}, which isn't one of your tools; it's ${who.join(", ")}'s. Hand this part to ${who.length > 1 ? "one of them" : who[0]} with mcp__team__delegate_task (say exactly what to find out or do), and carry on with your own part. Don't work around this.`
      : `\`${hit.cmd}\` is ${title}, which no agent of yours has. If the work needs it, call mcp__team__request_setup; don't work around this.`);
  };
}

// --- orchestrators -----------------------------------------------------------------------------------

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_HANDS_ON = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(commit|merge|rebase|cherry-pick|revert|apply|am|stash\s+pop|reset\s+--hard)\b/;
/** Shell writes into a path: redirects, tee, sed -i, cp/mv/rm/touch/mkdir with that path. */
function writesUnder(command: string, root: string): boolean {
  const r = esc(root.replace(/\/+$/, ""));
  return new RegExp(String.raw`(?:>>?|\btee(?:\s+-a)?)\s*["']?${r}/`).test(command)
    || new RegExp(String.raw`\b(?:sed\s+-i\S*|cp|mv|rm|touch|mkdir|ln|truncate|patch)\b[^;&|\n]*${r}/`).test(command);
}

export const isOrchestrator = (agent: Agent) => !!(getAgent(agent.base_agent_id ?? agent.id) ?? agent).can_scale;

/** Why this tool call is hands-on work an orchestrator should delegate (null: fine). */
export function handsOn(input: any, roots = [worktreesRoot(), reposRoot()]): string | null {
  const tool = String(input?.tool_name ?? "");
  if (EDIT_TOOLS.has(tool)) {
    const p = path.resolve(String(input.cwd ?? "/"), String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? ""));
    if (roots.some((r) => p === r || p.startsWith(r + path.sep))) return "editing code in a repo";
    return null;
  }
  if (tool !== "Bash") return null;
  const command = String(input.tool_input?.command ?? "");
  const m = GIT_HANDS_ON.exec(command);
  if (m) return `\`git ${m[1]}\``;
  // Working inside a worktree (cd into it, or a path under it) and writing there.
  const cwd = String(input.cwd ?? "");
  const inRepo = roots.some((r) => cwd === r || cwd.startsWith(r + path.sep));
  if (roots.some((r) => writesUnder(command, r)) || (inRepo && /(?:>>?|\btee\b|\bsed\s+-i)/.test(command.replace(/[0-9]?>&[0-9]|>\s*\/dev\/null/g, "")))) return "changing files in a repo";
  return null;
}

export function orchestratorGuard(agent: Agent) {
  return async (input: any) => {
    if (input?.hook_event_name !== "PreToolUse" || !isOrchestrator(agent)) return {};
    const what = handsOn(input);
    if (!what) return {};
    return deny(`You orchestrate; you don't do hands-on work (${what}). Delegate it with mcp__team__delegate_task: implementation and rework to coder (rework to the instance that wrote it), CI, deploys and infra to devops, vulnerabilities to security. Reading, planning, reviewing and merging PRs are yours.`);
  };
}
