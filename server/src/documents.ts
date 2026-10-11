import fs from "node:fs";
import path from "node:path";
import { all } from "./db.ts";
import { paths } from "./config.ts";
import { AGENTS_ROOT, WORK_ROOT, homeOf, type Agent } from "./agents.ts";

/**
 * Documents an agent produced, newest first. Two sources:
 * 1. document files anywhere in the agent's home (its docs/ folder, or folders it made such as
 *    requirements/), except its memory, configuration and instructions;
 * 2. document files it wrote with the Write tool elsewhere (e.g. under /work).
 * Only document types count, so code an agent writes in a repo doesn't clutter the list.
 */

const DOC_EXT = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".pdf", ".html", ".htm", ".csv", ".tsv",
  ".docx", ".xlsx", ".pptx", ".odt", ".rtf", ".png", ".jpg", ".jpeg", ".svg",
]);
const SKIP_DIRS = new Set(["memory", ".claude", "node_modules", ".git", ".venv", "venv", "__pycache__"]);
const MAX_FILES = 500;

export type DocumentInfo = {
  path: string;
  name: string;
  folder: string;
  /** Folder for display: "~/docs" inside the agent's home, the full path elsewhere. */
  location: string;
  size: number;
  modified: string;
  source: "home" | "written";
  task_id: string | null;
  task_title: string | null;
};

const isDoc = (p: string) => DOC_EXT.has(path.extname(p).toLowerCase());

function scan(dir: string, out: string[], depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scan(p, out, depth + 1);
    } else if (e.isFile() && isDoc(p) && !(depth === 0 && e.name === "CLAUDE.md")) {
      out.push(p);
    }
  }
}

export function listDocuments(agent: Agent, agentIds: string[]): DocumentInfo[] {
  const display = (folder: string) =>
    folder === homeOf(agent) ? "~" : folder.startsWith(homeOf(agent) + path.sep) ? `~/${path.relative(homeOf(agent), folder)}` : folder;
  const home = homeOf(agent);
  const found = new Map<string, Omit<DocumentInfo, "size" | "modified" | "name" | "folder" | "location">>();

  const homeFiles: string[] = [];
  scan(home, homeFiles);
  for (const p of homeFiles) found.set(p, { path: p, source: "home", task_id: null, task_title: null });

  // Files written with the Write tool, anywhere, with the task that wrote them (latest write wins).
  const marks = agentIds.map(() => "?").join(",");
  const written = all<{ path: string; task_id: string; title: string; at: string }>(
    `SELECT steps.summary AS path, steps.task_id, tasks.title, MAX(COALESCE(steps.finished_at, steps.started_at)) AS at
     FROM steps JOIN tasks ON tasks.id = steps.task_id
     WHERE tasks.agent_id IN (${marks}) AND steps.name = 'Write' AND steps.status = 'done'
     GROUP BY steps.summary`,
    ...agentIds,
  );
  for (const w of written) {
    if (!w.path || !isDoc(w.path) || !allowed(w.path)) continue;
    if (w.path.startsWith(path.join(home, "memory") + path.sep) || w.path === path.join(home, "CLAUDE.md")) continue;
    found.set(w.path, { path: w.path, source: found.get(w.path)?.source ?? "written", task_id: w.task_id, task_title: w.title });
  }

  const docs: DocumentInfo[] = [];
  for (const d of found.values()) {
    try {
      const st = fs.statSync(d.path);
      if (!st.isFile()) continue;
      docs.push({
        ...d,
        name: path.basename(d.path),
        folder: path.dirname(d.path),
        location: display(path.dirname(d.path)),
        size: st.size,
        modified: st.mtime.toISOString(),
      });
    } catch {
      // Deleted since it was written.
    }
  }
  return docs.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Only files under the agents' homes or the shared work area can be served. */
export function allowed(p: string) {
  if (!path.isAbsolute(p)) return false;
  const real = (() => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  })();
  // Plus the repos' knowledge packs (<data>/repos/<name>/map/).
  return [AGENTS_ROOT, WORK_ROOT, path.resolve(paths.data, "repos")].some((root) => real === root || real.startsWith(root + path.sep));
}

const TYPES: Record<string, string> = {
  ".gif": "image/gif", ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8", ".mdx": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".rst": "text/plain; charset=utf-8", ".adoc": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text", ".rtf": "application/rtf",
};
export const contentType = (p: string) => TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";

// --- documents for a piece of work (task room, group, instance) and across everything ---------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Absolute paths under the agents' homes or the work area (from the config, e.g. /agents or /agents-v21). */
const PATH_IN_TEXT = new RegExp(`(?:${[AGENTS_ROOT, WORK_ROOT].map((r) => esc(r.replace(/\/+$/, ""))).join("|")})\\/[^\\s\`'"<>()\\[\\]{},;|*]+`, "g");

function describe(p: string, extra: Partial<DocumentInfo>): DocumentInfo | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return {
      path: p, name: path.basename(p), folder: path.dirname(p), location: path.dirname(p), size: st.size,
      modified: st.mtime.toISOString(), source: "written", task_id: null, task_title: null, ...extra,
    };
  } catch {
    return null;
  }
}

/**
 * Documents produced by some tasks: files they wrote with the Write tool, plus document files
 * their conversations mention by full path (agents are told to give full paths).
 */
export function documentsForWork(taskIds: string[], threadIds: string[]): (DocumentInfo & { author: string | null })[] {
  const out = new Map<string, DocumentInfo & { author: string | null }>();
  for (let i = 0; i < taskIds.length; i += 400) {
    const ids = taskIds.slice(i, i + 400);
    const rows = all<{ path: string; task_id: string; title: string; agent_id: string }>(
      `SELECT steps.summary AS path, steps.task_id, tasks.title, tasks.agent_id FROM steps JOIN tasks ON tasks.id = steps.task_id
       WHERE steps.task_id IN (${ids.map(() => "?").join(",")}) AND steps.name = 'Write' AND steps.status = 'done'`,
      ...ids,
    );
    for (const r of rows) {
      if (!r.path || !isDoc(r.path) || !allowed(r.path) || /\/memory\/[^/]+$/.test(r.path)) continue;
      const d = describe(r.path, { task_id: r.task_id, task_title: r.title });
      if (d) out.set(r.path, { ...d, author: r.agent_id });
    }
    // Documents written from the shell (cat > file, tee file, cp …): the paths in the command.
    const shells = all<{ cmd: string; task_id: string; title: string; agent_id: string }>(
      `SELECT steps.summary AS cmd, steps.task_id, tasks.title, tasks.agent_id FROM steps JOIN tasks ON tasks.id = steps.task_id
       WHERE steps.task_id IN (${ids.map(() => "?").join(",")}) AND steps.name IN ('Shell', 'Bash') AND steps.status = 'done'`,
      ...ids,
    );
    for (const r of shells) {
      for (const raw of String(r.cmd ?? "").match(/(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&<>]+)/g) ?? []) {
        const p = raw.replace(/^(?:>>?|tee\s+(?:-a\s+)?)\s*["']?/, "");
        if (out.has(p) || !isDoc(p) || !allowed(p) || /\/memory\/[^/]+$/.test(p)) continue;
        const d = describe(p, { task_id: r.task_id, task_title: r.title });
        if (d) out.set(p, { ...d, author: r.agent_id });
      }
    }
  }
  for (const t of threadIds) {
    // Plans posted in this thread (their full text names the documents behind them).
    const plans = (() => { try { return all<{ body: string; instance_id: string; task_id: string | null }>(`SELECT body, instance_id, task_id FROM plans WHERE thread_id = ?`, t); } catch { return []; } })();
    const texts = [
      ...all<{ content: string; author: string; task_id: string | null }>(`SELECT content, author, task_id FROM messages WHERE thread_id = ?`, t),
      ...plans.map((p) => ({ content: p.body, author: p.instance_id, task_id: p.task_id })),
    ];
    for (const m of texts) {
      for (const raw of m.content.match(PATH_IN_TEXT) ?? []) {
        const p = raw.replace(/[.:,!?]+$/, "");
        if (out.has(p) || !isDoc(p) || !allowed(p) || /\/memory\/[^/]+$/.test(p) || p.endsWith("/CLAUDE.md")) continue;
        const d = describe(p, { task_id: m.task_id });
        if (d) out.set(p, { ...d, author: m.author === "user" ? null : m.author });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Every document across all agents, newest first. */
export function allDocuments(roles: Agent[], instancesOf: (roleId: string) => string[]) {
  const out = new Map<string, DocumentInfo & { author: string | null; role: string }>();
  for (const role of roles) {
    for (const d of listDocuments(role, [role.id, ...instancesOf(role.id)])) {
      if (!out.has(d.path)) out.set(d.path, { ...d, author: null, role: role.id });
    }
  }
  return [...out.values()].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 1000);
}

const SCRIPT_EXT = new Set([".sh", ".bash", ".py", ".js", ".mjs", ".ts", ".sql", ".jq", ".json", ".yml", ".yaml"]);

/** Every document or script in a shared folder (a task room's workspace). */
export function documentsInFolder(dir: string): (DocumentInfo & { author: string | null })[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || out.length > 300) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
      else if (e.isFile() && (isDoc(p) || SCRIPT_EXT.has(path.extname(p).toLowerCase()))) out.push(p);
    }
  };
  walk(dir, 0);
  return out.map((p) => {
    const st = fs.statSync(p);
    const rel = path.relative(dir, path.dirname(p));
    return {
      path: p, name: path.basename(p), folder: path.dirname(p), location: rel ? `shared/${rel}` : "shared",
      size: st.size, modified: st.mtime.toISOString(), source: "home" as const, task_id: null, task_title: null, author: null,
    };
  });
}
