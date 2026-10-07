import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const dataDir = process.env.AGENTBOX_DATA ?? path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "agentbox.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'sonnet',
  color TEXT NOT NULL,
  max_turns INTEGER NOT NULL DEFAULT 60,
  interview TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- dm (owner ↔ agent) · handoff (agent → agent) · group
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  peer_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, thread_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  input TEXT,
  output TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id, seq);
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id, created_at);
`);

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();

export type Row = Record<string, any>;

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

// --- migrations for databases created by earlier milestones -------------------
const columns = (table: string) => all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);

if (!columns("threads").includes("peer_agent_id")) {
  // Drop the old CHECK on threads.kind (SQLite can't alter it in place).
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE threads_new (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      peer_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO threads_new (id, kind, agent_id, name, created_at) SELECT id, kind, agent_id, name, created_at FROM threads;
    DROP TABLE threads;
    ALTER TABLE threads_new RENAME TO threads;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
for (const [col, type] of [
  ["title", "TEXT"],
  ["from_agent_id", "TEXT REFERENCES agents(id) ON DELETE SET NULL"],
  ["parent_task_id", "TEXT REFERENCES tasks(id) ON DELETE SET NULL"],
  ["depth", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  if (!columns("tasks").includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
}
for (const [col, type] of [
  ["purpose", "TEXT"],
  ["lead_agent_id", "TEXT REFERENCES agents(id) ON DELETE SET NULL"],
  ["paused_mentions", "TEXT"], // JSON agent ids waiting when a group hit its turn limit
] as const) {
  if (!columns("threads").includes(col)) db.exec(`ALTER TABLE threads ADD COLUMN ${col} ${type}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, agent_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS group_reads (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS threads_handoff ON threads(kind, agent_id, peer_agent_id) WHERE kind = 'handoff'`);

// A task that was running when the server stopped can never finish; mark it.
run(
  `UPDATE tasks SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ?
   WHERE status IN ('running', 'queued')`,
  now(),
);
run(`UPDATE steps SET status = 'error' WHERE status = 'running'`);
