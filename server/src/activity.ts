import { all } from "./db.ts";
import { auditTitle } from "./devices.ts";

/**
 * The activity feed and the delegation graph, built from what's already recorded (tasks, steps,
 * skill drafts, routine runs) rather than a separate log, so they never drift from reality.
 */

export type ActivityItem = {
  id: string;
  ts: string;
  kind: "asked" | "delegated" | "message" | "report" | "routine" | "group" | "finished" | "failed" | "stopped" | "github" | "skill" | "skipped" | "phone";
  actor: string;          // "user" | agent id | "routine" | "system"
  agent_id: string | null; // who the item is about / who did it
  title: string;
  detail?: string;
  task_id?: string | null;
  link?: string;
};

// Shell commands worth surfacing on their own.
const NOTABLE: [RegExp, string][] = [
  [/\bgh pr create\b/, "opened a pull request"],
  [/\bgh pr merge\b/, "merged a pull request"],
  [/\bgh pr review\b/, "reviewed a pull request"],
  [/\bgh issue create\b/, "filed an issue"],
  [/\bgit push\b/, "pushed commits"],
  [/\baws\s/, "ran an AWS command"],
];

const START_KIND: Record<string, ActivityItem["kind"]> = {
  user: "asked", agent: "delegated", message: "message", result: "report", cron: "routine", group: "group",
};

export function activity({ limit, agent }: { limit: number; agent?: string }): ActivityItem[] {
  const items: ActivityItem[] = [];
  const byAgent = agent ? `AND (tasks.agent_id = ? OR tasks.from_agent_id = ?)` : "";
  const agentParams = agent ? [agent, agent] : [];

  const tasks = all(
    `SELECT tasks.*, threads.kind AS thread_kind, threads.name AS thread_name,
            (SELECT COUNT(*) FROM steps WHERE steps.task_id = tasks.id AND steps.kind != 'meta') AS steps
     FROM tasks LEFT JOIN threads ON threads.id = tasks.thread_id
     WHERE 1 = 1 ${byAgent} ORDER BY tasks.created_at DESC LIMIT ?`,
    ...agentParams, limit,
  );
  for (const t of tasks) {
    const kind = START_KIND[t.source] ?? "asked";
    // Reports are noise as a separate "started" row; the delegated task's "finished" row covers it.
    if (kind !== "report") {
      items.push({
        id: `${t.id}:start`, ts: t.created_at, kind,
        actor: t.source === "user" ? "user" : t.source === "cron" ? "routine" : t.from_agent_id ?? "user",
        agent_id: t.agent_id, title: t.title ?? "", task_id: t.id,
        detail: t.source === "group" ? `#${t.thread_name}` : undefined,
      });
    }
    if (t.finished_at && ["done", "failed", "stopped"].includes(t.status)) {
      items.push({
        id: `${t.id}:end`, ts: t.finished_at,
        kind: t.status === "done" ? "finished" : t.status === "failed" ? "failed" : "stopped",
        actor: t.agent_id, agent_id: t.agent_id, title: t.title ?? "", task_id: t.id,
        detail: t.status === "failed" ? t.error ?? undefined : `${t.steps} step${t.steps === 1 ? "" : "s"}`,
      });
    }
  }

  const steps = all(
    `SELECT steps.id, steps.task_id, steps.summary, steps.started_at, steps.status, tasks.agent_id
     FROM steps JOIN tasks ON tasks.id = steps.task_id
     WHERE steps.kind = 'shell' AND (steps.summary LIKE '%gh pr %' OR steps.summary LIKE '%gh issue create%'
       OR steps.summary LIKE '%git push%' OR steps.summary LIKE '%aws %') ${byAgent}
     ORDER BY steps.started_at DESC LIMIT ?`,
    ...agentParams, limit,
  );
  for (const s of steps) {
    const hit = NOTABLE.find(([re]) => re.test(s.summary));
    if (!hit || s.status === "error") continue;
    items.push({
      id: s.id, ts: s.started_at, kind: "github", actor: s.agent_id, agent_id: s.agent_id,
      title: hit[1], detail: s.summary, task_id: s.task_id,
    });
  }

  if (!agent) {
    for (const d of all(`SELECT * FROM skill_drafts ORDER BY created_at DESC LIMIT 50`)) {
      items.push({
        id: `draft:${d.id}`, ts: d.created_at, kind: "skill", actor: d.proposed_by, agent_id: d.proposed_by,
        title: `proposed the skill ${d.name}`, detail: d.status === "pending" ? "waiting for your review" : d.status,
        link: `#/skills/drafts/${d.id}`,
      });
    }
    for (const r of all(
      `SELECT routine_runs.*, routines.name, routines.agent_id FROM routine_runs JOIN routines ON routines.id = routine_runs.routine_id
       WHERE outcome = 'skipped' ORDER BY at DESC LIMIT 50`,
    )) {
      items.push({
        id: `run:${r.id}`, ts: r.at, kind: "skipped", actor: "routine", agent_id: r.agent_id,
        title: `skipped routine "${r.name}"`, detail: r.reason, link: `#/routines/${r.routine_id}`,
      });
    }
  }

  // What the owner did from a paired phone (mobile gateway audit).
  if (!agent) {
    for (const a of all(`SELECT * FROM device_audit ORDER BY ts DESC LIMIT ?`, limit)) {
      items.push({
        id: `phone:${a.id}`, ts: a.ts, kind: "phone", actor: "user", agent_id: null,
        title: a.path === "file" && a.ref_id ? `opened ${a.ref_id.split("/").pop()}` : auditTitle(a.path),
        detail: `via phone (${a.device_name})`,
        link: a.path === "file" && a.ref_id ? `/api/file?path=${encodeURIComponent(a.ref_id)}`
          : a.path === "work" && a.ref_id ? `#/work/${a.ref_id}` : /^routines\//.test(a.path) && a.ref_id ? `#/routines/${a.ref_id}` : undefined,
      });
    }
  }

  return items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

export function graph(since: string) {
  const edges = all<{ from: string; to: string; kind: string; n: number; last: string }>(
    `SELECT CASE source WHEN 'agent' THEN COALESCE((SELECT base_agent_id FROM agents WHERE id = from_agent_id), from_agent_id)
                        WHEN 'message' THEN COALESCE((SELECT base_agent_id FROM agents WHERE id = from_agent_id), from_agent_id)
                        WHEN 'cron' THEN 'routine' ELSE 'user' END AS "from",
            COALESCE((SELECT base_agent_id FROM agents WHERE id = tasks.agent_id), tasks.agent_id) AS "to",
            CASE source WHEN 'agent' THEN 'delegated' WHEN 'message' THEN 'message' WHEN 'cron' THEN 'routine' ELSE 'asked' END AS kind,
            COUNT(*) AS n, MAX(created_at) AS last
     FROM tasks
     WHERE source IN ('user', 'agent', 'message', 'cron') AND created_at >= ?
     GROUP BY 1, 2, 3`,
    since,
  );
  return { edges: edges.filter((e) => e.from) };
}
