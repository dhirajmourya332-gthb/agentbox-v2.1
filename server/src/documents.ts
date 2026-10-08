import fs from "node:fs";
import path from "node:path";
import { all } from "./db.ts";
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
  return [AGENTS_ROOT, WORK_ROOT].some((root) => real === root || real.startsWith(root + path.sep));
}

const TYPES: Record<string, string> = {
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
