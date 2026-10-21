import type { FastifyInstance } from "fastify";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent } from "./agents.ts";

/**
 * The owner's notebook for a piece of work: plain-text notes kept beside the task room, so a link or
 * an answer an agent gave doesn't get lost up the chat. A note is either written fresh, or saved from
 * a selection in the chat (the quoted text, plus an optional note of the owner's own). Notes belong to
 * the work's root task: a task and every task it started share one notebook. Owner-only; agents
 * neither read nor write them.
 */

run(`CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,               -- the work's root task (instance)
  quote TEXT,                          -- text saved from the chat, as selected
  body TEXT NOT NULL DEFAULT '',       -- the owner's own words
  message_id TEXT,                     -- the chat message the quote came from
  author TEXT,                         -- who wrote that message (an agent id, or "user")
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
run(`CREATE INDEX IF NOT EXISTS notes_room ON notes(room_id, created_at)`);

export type Note = { id: string; room_id: string; quote: string | null; body: string; message_id: string | null; author: string | null; created_at: string; updated_at: string };

const MAX = 20_000;
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The root of the work an instance belongs to (itself when it was started by the owner). */
export function workRoot(instanceId: string): string {
  let a = getAgent(instanceId);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  for (let i = 0; i < 50 && a.parent_instance_id; i++) {
    const up = getAgent(a.parent_instance_id);
    if (!up) break;
    a = up;
  }
  return a.id;
}

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");

export function listNotes(roomId: string): Note[] {
  return all<Note>(`SELECT * FROM notes WHERE room_id = ? ORDER BY created_at DESC`, roomId);
}

export function addNote(instanceId: string, input: { quote?: unknown; body?: unknown; message_id?: unknown; author?: unknown }): Note {
  const roomId = workRoot(instanceId);
  const quote = clean(input.quote) || null;
  const body = clean(input.body);
  if (!quote && !body) throw httpError(400, "The note is empty");
  if ((quote?.length ?? 0) > MAX || body.length > MAX) throw httpError(400, `A note is at most ${MAX} characters`);
  const t = now();
  const note: Note = {
    id: newId(), room_id: roomId, quote, body,
    message_id: typeof input.message_id === "string" ? input.message_id : null,
    author: typeof input.author === "string" ? input.author : null,
    created_at: t, updated_at: t,
  };
  run(`INSERT INTO notes (id, room_id, quote, body, message_id, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    note.id, note.room_id, note.quote, note.body, note.message_id, note.author, note.created_at, note.updated_at);
  publish({ type: "notes.updated", roomId });
  return note;
}

export function updateNote(id: string, input: { body?: unknown }): Note {
  const note = get<Note>(`SELECT * FROM notes WHERE id = ?`, id);
  if (!note) throw httpError(404, "No such note");
  const body = clean(input.body);
  if (!note.quote && !body) throw httpError(400, "The note is empty");
  if (body.length > MAX) throw httpError(400, `A note is at most ${MAX} characters`);
  const t = now();
  run(`UPDATE notes SET body = ?, updated_at = ? WHERE id = ?`, body, t, id);
  publish({ type: "notes.updated", roomId: note.room_id });
  return { ...note, body, updated_at: t };
}

export function deleteNote(id: string) {
  const note = get<Note>(`SELECT * FROM notes WHERE id = ?`, id);
  if (!note) throw httpError(404, "No such note");
  run(`DELETE FROM notes WHERE id = ?`, id);
  publish({ type: "notes.updated", roomId: note.room_id });
  return { ok: true };
}

export function registerNoteRoutes(app: FastifyInstance) {
  // :id is any task in the work; the notebook is its root's.
  app.get("/api/work/:id/notes", async (req) => {
    const roomId = workRoot((req.params as any).id);
    return { room_id: roomId, notes: listNotes(roomId) };
  });
  app.post("/api/work/:id/notes", async (req) => addNote((req.params as any).id, (req.body ?? {}) as any));
  app.patch("/api/notes/:id", async (req) => updateNote((req.params as any).id, (req.body ?? {}) as any));
  app.delete("/api/notes/:id", async (req) => deleteNote((req.params as any).id));
}
