import fs from "node:fs";
import path from "node:path";
import { all, dataDir, db, get, newId, now, run } from "./db.ts";
import type { Agent } from "./agents.ts";

/**
 * One-time move to "one instance per task" (backlog #5). Each agent (role) that has a
 * conversation gets an instance that takes over that conversation unchanged: its threads, the
 * resumable Claude session, its tasks and messages. Routines get a dedicated instance each.
 * Runs inside one transaction after a full database backup; nothing is deleted except empty,
 * unused chat threads of roles.
 */

const MARK = "instances_v1";

const count = (sql: string, ...p: any[]) => (get<{ n: number }>(sql, ...p)?.n ?? 0) as number;

export function snapshotCounts() {
  return {
    messages: count(`SELECT COUNT(*) AS n FROM messages`),
    tasks: count(`SELECT COUNT(*) AS n FROM tasks`),
    steps: count(`SELECT COUNT(*) AS n FROM steps`),
    sessions: count(`SELECT COUNT(*) AS n FROM agent_sessions`),
    events: count(`SELECT COUNT(*) AS n FROM events`),
  };
}

function latestTitle(threadId: string) {
  const t = get<{ title: string }>(
    `SELECT title FROM tasks WHERE thread_id = ? AND source = 'user' AND title IS NOT NULL ORDER BY created_at DESC LIMIT 1`, threadId,
  )?.title;
  return t ? t.slice(0, 80) : "Earlier chat";
}

function insertInstance(role: Agent, n: number, label: string, createdBy: string) {
  const id = newId();
  let slug = `${role.slug}-${n}`;
  while (get(`SELECT 1 FROM agents WHERE slug = ?`, slug)) slug += "x";
  run(
    `INSERT INTO agents (id, slug, name, title, summary, model, color, max_turns, interview, created_at, base_agent_id, replica_no,
                         home_slug, can_scale, created_by, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
    id, slug, `${role.name}#${n}`, role.title, role.summary, role.model, role.color, role.max_turns, now(), role.id, n,
    role.home_slug ?? role.slug, role.can_scale ?? 0, createdBy, label,
  );
  return id;
}

/** Point a thread and everything recorded in it at the instance instead of the role. */
function moveThread(threadId: string, roleId: string, instanceId: string) {
  run(`UPDATE threads SET agent_id = ? WHERE id = ?`, instanceId, threadId);
  run(`UPDATE agent_sessions SET agent_id = ? WHERE agent_id = ? AND thread_id = ?`, instanceId, roleId, threadId);
  run(`UPDATE tasks SET agent_id = ? WHERE agent_id = ? AND thread_id = ?`, instanceId, roleId, threadId);
  run(`UPDATE messages SET author = ? WHERE author = ? AND thread_id = ?`, instanceId, roleId, threadId);
}

export function migrateToInstances(log: (s: string) => void = console.log) {
  if (get(`SELECT 1 FROM meta WHERE key = ?`, MARK)) return { skipped: true as const };

  const before = snapshotCounts();
  const backups = path.join(dataDir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  const backup = path.join(backups, `agentbox-before-instances-${now().replace(/[:.]/g, "-")}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  log(`migration: backup written to ${backup}`);

  const report: string[] = [];
  db.exec("BEGIN");
  try {
    const nextNo = (roleId: string) => count(`SELECT COALESCE(MAX(replica_no), 0) AS n FROM agents WHERE base_agent_id = ?`, roleId) + 1;

    for (const role of all<Agent>(`SELECT * FROM agents WHERE base_agent_id IS NULL`)) {
      const threads = all<{ id: string; kind: string }>(`SELECT id, kind FROM threads WHERE agent_id = ? AND kind != 'routine'`, role.id);
      const used = threads.filter((t) => count(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?`, t.id) > 0
        || count(`SELECT COUNT(*) AS n FROM tasks WHERE thread_id = ?`, t.id) > 0);
      // Roles don't hold conversations any more: drop their empty, unused chat threads.
      for (const t of threads.filter((t) => !used.includes(t))) run(`DELETE FROM threads WHERE id = ?`, t.id);
      if (!used.length) continue;
      const dm = used.find((t) => t.kind === "dm") ?? used[0];
      const instanceId = insertInstance(role, nextNo(role.id), latestTitle(dm.id), "owner");
      // The task started when its conversation did, not at migration time.
      run(`UPDATE agents SET created_at = COALESCE((SELECT MIN(created_at) FROM messages WHERE thread_id = ?), created_at) WHERE id = ?`, dm.id, instanceId);
      for (const t of used) moveThread(t.id, role.id, instanceId);
      report.push(`${role.name}: conversation moved to ${role.name}#… (${used.length} thread(s))`);
    }

    // Replicas from before become ordinary instances started by the owner.
    for (const r of all<Agent>(`SELECT * FROM agents WHERE base_agent_id IS NOT NULL AND created_by IS NULL`)) {
      const dm = get<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ? AND kind = 'dm'`, r.id);
      run(`UPDATE agents SET created_by = 'owner', label = COALESCE(label, ?) WHERE id = ?`, dm ? latestTitle(dm.id) : "Task", r.id);
    }

    // Each routine runs on its own instance, created with it and retired with it.
    for (const rt of all<{ id: string; agent_id: string; thread_id: string; name: string; instance_id: string | null }>(
      `SELECT id, agent_id, thread_id, name, instance_id FROM routines`,
    )) {
      if (rt.instance_id) continue;
      const role = get<Agent>(`SELECT * FROM agents WHERE id = ?`, rt.agent_id);
      if (!role) continue;
      const instanceId = insertInstance(role, nextNo(role.id), rt.name, `routine:${rt.id}`);
      moveThread(rt.thread_id, role.id, instanceId);
      run(`UPDATE routines SET instance_id = ? WHERE id = ?`, instanceId, rt.id);
      report.push(`routine "${rt.name}": runs on its own ${role.name} instance`);
    }

    // Groups list agents (roles); an instance listed as a member becomes its role.
    for (const m of all<{ thread_id: string; agent_id: string; base: string }>(
      `SELECT tm.thread_id, tm.agent_id, a.base_agent_id AS base FROM thread_members tm JOIN agents a ON a.id = tm.agent_id
       WHERE a.base_agent_id IS NOT NULL`,
    )) {
      run(`DELETE FROM thread_members WHERE thread_id = ? AND agent_id = ?`, m.thread_id, m.agent_id);
      run(`INSERT OR IGNORE INTO thread_members (thread_id, agent_id) VALUES (?, ?)`, m.thread_id, m.base);
    }

    const after = snapshotCounts();
    for (const k of ["messages", "tasks", "steps", "sessions"] as const) {
      if (after[k] !== before[k]) throw new Error(`migration check failed: ${k} ${before[k]} → ${after[k]}`);
    }
    run(`INSERT INTO meta (key, value) VALUES (?, ?)`, MARK, now());
    db.exec("COMMIT");
    for (const line of report) log(`migration: ${line}`);
    log(`migration: done; counts unchanged ${JSON.stringify(after)}`);
    return { skipped: false as const, backup, report, counts: after };
  } catch (e) {
    db.exec("ROLLBACK");
    log(`migration: rolled back: ${String((e as Error).message)}`);
    throw e;
  }
}
