import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { get } from "./db.ts";
import { getAgent, instanceTree, rootOf, type Agent } from "./agents.ts";

/**
 * Routine rules: the owner's standing orders for everyone working in a routine. They take
 * precedence over job descriptions inside that routine (in both directions), never over the
 * team-wide rules. Permissions are switches; null means "as in the job description". Merges into
 * main, deploy workflows and issue creation are also enforced before a command runs.
 */

export type MergeMain = "never" | "safe" | "allowed";
export type Deploy = "none" | "staging" | "production";
export type RoutineRules = {
  everyone: string;
  roles: Record<string, string>; // role (agent) id → instructions for that role
  perms: {
    merge_main: MergeMain | null;
    deploy: Deploy | null;
    issues: boolean | null;
    teams: boolean | null;
    max_helpers: number | null; // live instances the group may start, besides the routine's agent and lead
  };
};

export const EMPTY_RULES: RoutineRules = {
  everyone: "", roles: {}, perms: { merge_main: null, deploy: null, issues: null, teams: null, max_helpers: null },
};

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
const bool = (v: unknown) => (v === true || v === false ? v : null);

/** Validate rules from the API (unknown fields dropped, text trimmed and capped). */
export function normalizeRules(input: any): RoutineRules {
  const r = input ?? {};
  const roles: Record<string, string> = {};
  for (const [id, text] of Object.entries(r.roles ?? {})) {
    const t = String(text ?? "").trim().slice(0, 4000);
    const role = getAgent(id);
    if (t && role && !role.base_agent_id) roles[id] = t;
  }
  const n = Number(r.perms?.max_helpers);
  return {
    everyone: String(r.everyone ?? "").trim().slice(0, 4000),
    roles,
    perms: {
      merge_main: pick(r.perms?.merge_main, ["never", "safe", "allowed"] as const),
      deploy: pick(r.perms?.deploy, ["none", "staging", "production"] as const),
      issues: bool(r.perms?.issues),
      teams: bool(r.perms?.teams),
      max_helpers: Number.isInteger(n) && n >= 0 && n <= 20 && r.perms?.max_helpers !== null && r.perms?.max_helpers !== "" ? n : null,
    },
  };
}

export function parseRules(json: string | null | undefined): RoutineRules {
  if (!json) return EMPTY_RULES;
  try { return normalizeRules(JSON.parse(json)); } catch { return EMPTY_RULES; }
}

/** The routine an instance works in (through its task tree), with its rules. */
export function routineOf(agent: Agent): { id: string; name: string; rules: RoutineRules; instanceId: string } | null {
  if (!agent.base_agent_id) return null;
  const root = rootOf(agent);
  if (!root.created_by?.startsWith("routine:")) return null;
  const r = get<{ id: string; name: string; rules: string | null }>(
    `SELECT id, name, rules FROM routines WHERE id = ?`, root.created_by.slice("routine:".length),
  );
  return r ? { id: r.id, name: r.name, rules: parseRules(r.rules), instanceId: root.id } : null;
}

const MERGE_TEXT: Record<MergeMain, string> = {
  never: "**not allowed.** Don't merge anything into `main`; leave the PR open with your conclusion for the owner. Merges into epic branches are fine.",
  safe: "**allowed for safe PRs only:** small, CI green, every review comment resolved, and for security fixes a breaking-changes verdict of \"none\" with High confidence. Anything else: leave it for the owner.",
  allowed: "**allowed** after your normal review, including PRs your job description says to ask about. Still never merge an epic into `main` without the owner.",
};
const DEPLOY_TEXT: Record<Deploy, string> = {
  none: "**not allowed.** Don't trigger deploy workflows or deploy in any other way.",
  staging: "**staging only**, through the service's existing workflow, without asking first. Never production.",
  production: "**allowed to staging and production** through the service's existing workflow, without asking first. Verify health after each deploy and post the release note.",
};

export function summarizePerms(p: RoutineRules["perms"]) {
  const out: string[] = [];
  if (p.merge_main) out.push(`merge to main: ${p.merge_main === "safe" ? "safe PRs only" : p.merge_main}`);
  if (p.deploy) out.push(`deploy: ${p.deploy}`);
  if (p.issues !== null) out.push(`GitHub issues: ${p.issues ? "yes" : "no"}`);
  if (p.teams !== null) out.push(`Teams posts: ${p.teams ? "yes" : "no"}`);
  if (p.max_helpers !== null) out.push(`helpers: ${p.max_helpers}`);
  return out;
}

/** The "This routine's rules" section of the system prompt, for anyone in a routine's group. */
export function rulesNote(agent: Agent): string {
  const rt = routineOf(agent);
  if (!rt) return "";
  const { rules } = rt;
  const p = rules.perms;
  const perms: string[] = [];
  if (p.merge_main) perms.push(`- Merging PRs into \`main\`: ${MERGE_TEXT[p.merge_main]}`);
  if (p.deploy) perms.push(`- Deploying: ${DEPLOY_TEXT[p.deploy]}`);
  if (p.issues !== null) perms.push(`- Filing GitHub issues: ${p.issues ? "**allowed**, following the team's issue rules." : "**not allowed.** Report what you'd file instead."}`);
  if (p.teams !== null) perms.push(`- Posting in Teams: ${p.teams ? "**allowed** where your job description says to post." : "**not allowed.** Put it in your report instead."}`);
  if (p.max_helpers !== null) perms.push(`- Starting helpers: at most **${p.max_helpers}** live instance(s) in this routine at once, besides its agent and lead.`);
  const mine = rules.roles[agent.base_agent_id!] ?? "";
  if (!perms.length && !rules.everyone && !mine) return "";
  return `## This routine's rules (set by the owner)
You're working in the routine "${rt.name}". These rules take precedence over your job description wherever they
differ, in both directions: they can allow something your job description says to ask about, or forbid something
it allows. They never override the team-wide rules (secrets, live data, no re-authentication). Merges into
\`main\`, deploys and issue creation are checked before a command runs: if one is blocked, this routine doesn't
allow it. Don't work around it; report it.
${perms.length ? `\n${perms.join("\n")}\n` : ""}${rules.everyone ? `\n**For everyone in this routine:**\n${rules.everyone}\n` : ""}${mine ? `\n**For you (${getAgent(agent.base_agent_id!)?.name}):**\n${mine}\n` : ""}
`;
}

/** Live helper instances in a routine's group, against its limit. */
export function helperLimitError(from: Agent): string | null {
  const rt = routineOf(from);
  const max = rt?.rules.perms.max_helpers;
  if (!rt || max === null || max === undefined) return null;
  const live = instanceTree(rt.instanceId).filter((a) => !a.retired_at && !a.created_by?.startsWith("routine:") && !a.created_by?.startsWith("lead:"));
  return live.length >= max
    ? `This routine allows at most ${max} helper instance(s) at once, and ${live.length} are live (${live.map((a) => a.name).join(", ") || "none"}). Reuse one, retire a finished one, or do it yourself.`
    : null;
}

// --- enforcement ------------------------------------------------------------------------------

const run = promisify(execFile);
export const DEPLOY_WORKFLOW = /deploy|build-push|release|rollout|rollback/i;

/** The base branch of the PR a merge command names, or null when it can't be told. */
export async function prBase(command: string): Promise<string | null> {
  const url = command.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  const num = url?.[2] ?? command.match(/gh\s+pr\s+merge\s+(?:--?\S+\s+)*#?(\d+)/)?.[1] ?? command.match(/pulls\/(\d+)\/merge/)?.[1];
  const repo = url?.[1] ?? command.match(/(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/)?.[1] ?? command.match(/repos\/([\w.-]+\/[\w.-]+)\/pulls/)?.[1];
  if (!num || !repo) return null;
  try {
    const { stdout } = await run("gh", ["pr", "view", num, "-R", repo, "--json", "baseRefName", "-q", ".baseRefName"], { timeout: 20_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The deploy workflow a command dispatches (gh workflow run / the dispatches API), or null. Drift reports are read-only. */
export function deployWorkflowOf(command: string): string | null {
  const dispatch = command.match(/gh\s+workflow\s+run\s+["']?([\w./-]+)/)?.[1] ?? command.match(/actions\/workflows\/([\w.-]+)\/dispatches/)?.[1];
  return dispatch && DEPLOY_WORKFLOW.test(dispatch) && !/drift/i.test(dispatch) ? dispatch : null;
}

/** Why this shell command breaks the routine's rules, or null. */
export async function ruleViolation(agent: Agent, command: string): Promise<string | null> {
  const rt = routineOf(agent);
  if (!rt) return null;
  const p = rt.rules.perms;
  const where = `the routine "${rt.name}"`;

  if (p.merge_main && p.merge_main !== "allowed") {
    if (/(^|[\s;&|(])git\s+push\b[^;&|]*(\s|:)(main|master)(\s|$|;|&|\|)/.test(command)) {
      return `${where} doesn't allow pushing to main. Open a PR instead.`;
    }
    if (p.merge_main === "never" && /gh\s+pr\s+merge\b|pulls\/\d+\/merge/.test(command)) {
      const base = await prBase(command);
      if (base === null) {
        return `${where} doesn't allow merging into main, and the PR's base couldn't be confirmed. Name the repo (-R owner/repo) or use the PR URL so it can be checked; merges into epic branches are allowed.`;
      }
      if (base === "main" || base === "master") return `${where} doesn't allow merging into ${base}. Leave the PR open with your conclusion for the owner.`;
    }
  }
  if (p.deploy && p.deploy !== "production") {
    const dispatch = deployWorkflowOf(command);
    if (dispatch) {
      if (p.deploy === "none") return `${where} doesn't allow deploying (${dispatch}).`;
      if (/\bprod(uction)?\b/i.test(command)) return `${where} allows deploying to staging only, and this targets production.`;
    }
  }
  if (p.issues === false && /gh\s+issue\s+create\b/.test(command)) {
    return `${where} doesn't allow filing GitHub issues. Put what you'd file in your report.`;
  }
  return null;
}

/** PreToolUse hook: deny shell commands the routine's rules don't allow. */
export function rulesGuard(agent: Agent) {
  return async (input: any) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const why = await ruleViolation(agent, String(input.tool_input?.command ?? ""));
    if (!why) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Blocked by the owner's rules for this routine: ${why}`,
      },
    };
  };
}
