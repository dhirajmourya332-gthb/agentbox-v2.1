import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./config.ts";

export const dataDir = paths.data;
// The DB holds conversations and tokens: not readable by anyone but the agent user.
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

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
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_id, created_at);
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
// Replicas: extra copies of an agent (coder#1, coder#2…) sharing its home, instructions,
// skills and memory, each with its own queue and conversations.
for (const [col, type] of [
  ["base_agent_id", "TEXT REFERENCES agents(id) ON DELETE CASCADE"],
  ["replica_no", "INTEGER"],
  ["home_slug", "TEXT"],
  ["retired_at", "TEXT"],
  ["max_replicas", "INTEGER NOT NULL DEFAULT 0"],
  ["can_scale", "INTEGER NOT NULL DEFAULT 0"],
  ["created_by", "TEXT"],
  ["parent_instance_id", "TEXT"],
  ["label", "TEXT"],
  ["kept", "INTEGER NOT NULL DEFAULT 0"],
  ["workspace", "TEXT"],           // task rooms: the shared folder (on the room's root instance)
  ["context_tokens", "INTEGER"],   // instances: size of the conversation after its last turn
] as const) {
  if (!columns("agents").includes(col)) db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${type}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS group_reads (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id)`);
// Phones paired through the mobile gateway (docs/MOBILE-PROTOCOL.md). Revoked devices are deleted;
// the audit keeps a copy of the name so the Activity feed still reads well afterwards.
db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,   -- base64url, 32 bytes (Ed25519)
  fingerprint TEXT NOT NULL,
  app_version TEXT,
  tailnet_login TEXT,                -- Tailscale-User-Login at pairing; later requests must match
  status TEXT NOT NULL,              -- pending | active
  created_at TEXT NOT NULL,
  approved_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS device_pairings (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,           -- hex sha256(code); the code itself is never stored
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS device_audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,                -- the internal route, without the query string
  status INTEGER NOT NULL,
  ref_id TEXT                        -- what it acted on (task instance, thread, routine…), if known
);
CREATE INDEX IF NOT EXISTS device_audit_ts ON device_audit(ts);
`);
// Push notifications (push.ts): the device's Expo push token. It lives on the device row, so a
// revoke, forget, deny or revoke-all (which delete the row) removes it too. Never sent to the portal.
for (const [col, type] of [
  ["push_token", "TEXT"],
  ["push_token_at", "TEXT"],
] as const) {
  if (!columns("devices").includes(col)) db.exec(`ALTER TABLE devices ADD COLUMN ${col} ${type}`);
}
// "Needs you" items (attention.ts, docs/CONTRACTS-v2.md § B). room_id is a task room's root
// instance id or a group id.
db.exec(`
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- reply | failed | stalled | question
  agent_id TEXT NOT NULL,
  task_id TEXT,
  room_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS attention_unseen ON attention(seen_at, created_at);
CREATE INDEX IF NOT EXISTS attention_room ON attention(room_id, seen_at);
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS threads_handoff ON threads(kind, agent_id, peer_agent_id) WHERE kind = 'handoff'`);

// A task that was running when the server stopped can never finish; mark it.
run(
  `UPDATE tasks SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ?
   WHERE status IN ('running', 'queued')`,
  now(),
);
run(`UPDATE steps SET status = 'error' WHERE status = 'running'`);
