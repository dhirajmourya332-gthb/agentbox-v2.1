import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { createAgent, getAgent, readInstructions, writeInstructions, type Agent } from "./agents.ts";

/**
 * The setup agent (docs/V2-ARCHITECTURE.md §10.4): a permanent built-in role, seeded at start.
 * Its CLAUDE.md comes from server/setup-agent/CLAUDE.md and is owned by agentbox (rewritten at every
 * start, refused through the API); the owner adds notes in a separate field. It can't be deleted or
 * renamed, and only the owner starts its tasks.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SETUP_TEMPLATE = path.resolve(here, "../setup-agent/CLAUDE.md");
export const SETUP_TITLE = "Setup & integrations";

// Additive migration: which roles are built in, and the owner's notes for them.
{
  const cols = all<{ name: string }>(`PRAGMA table_info(agents)`).map((c) => c.name);
  if (!cols.includes("builtin")) run(`ALTER TABLE agents ADD COLUMN builtin TEXT`);
  if (!cols.includes("owner_notes")) run(`ALTER TABLE agents ADD COLUMN owner_notes TEXT`);
}

export const setupRole = () => get<Agent>(`SELECT * FROM agents WHERE builtin = 'setup' AND base_agent_id IS NULL`);

/** The setup role itself or one of its tasks. */
export function isSetupAgent(a: Agent | undefined | null): boolean {
  if (!a) return false;
  if (a.builtin === "setup" && !a.base_agent_id) return true;
  return !!a.base_agent_id && getAgent(a.base_agent_id)?.builtin === "setup";
}

export function setupTemplate(): string {
  return fs.readFileSync(SETUP_TEMPLATE, "utf8");
}

/** Seed the setup role if it's missing; keep its CLAUDE.md equal to the template. */
export function ensureSetupRole(): Agent {
  const text = setupTemplate();
  let role = setupRole();
  if (!role) {
    // A user-made agent may already be called "setup": leave it alone and use another name.
    const name = get(`SELECT 1 FROM agents WHERE slug = 'setup'`) ? "setup-agent" : "setup";
    role = createAgent({
      name, title: SETUP_TITLE, model: "sonnet", instructions: text, interview: { builtin: "setup" },
      summary: "Connects, verifies and disconnects integrations (code hosting, cloud, clusters, databases…) and repairs base modules. Built into agentbox.",
    });
    run(`UPDATE agents SET builtin = 'setup' WHERE id = ?`, role.id);
    role = getAgent(role.id)!;
    publish({ type: "agent.updated", agent: role });
  } else if (readInstructions(role) !== text) {
    writeInstructions(role, text);
  }
  return role;
}

export function setOwnerNotes(roleId: string, text: string) {
  const a = getAgent(roleId);
  if (!a || a.base_agent_id) throw new Error("No such agent");
  if (!a.builtin) throw new Error("Notes are for built-in agents; edit this agent's instructions instead");
  const notes = String(text ?? "").slice(0, 8000);
  run(`UPDATE agents SET owner_notes = ? WHERE id = ?`, notes, roleId);
  const next = getAgent(roleId)!;
  publish({ type: "agent.updated", agent: next });
  return next;
}

/**
 * Open (or create) the setup task for one integration action, e.g. "Connect GitHub". A live task
 * with the same title is reused, so clicking Connect twice doesn't start two agents.
 */
export function setupTaskFor(
  action: "connect" | "reconnect" | "disconnect", it: { id: string; title: string },
  deps: { spawn: (roleId: string, label: string) => Agent; send: (instanceId: string, text: string) => void; card: (instanceId: string) => void },
) {
  const role = setupRole();
  if (!role) throw new Error("The setup agent is missing; restart agentbox");
  const verb = action === "connect" ? "Connect" : action === "reconnect" ? "Reconnect" : "Disconnect";
  const label = `${verb} ${it.title}`;
  const existing = get<Agent>(
    `SELECT * FROM agents WHERE base_agent_id = ? AND retired_at IS NULL AND label = ? ORDER BY created_at DESC LIMIT 1`, role.id, label,
  );
  if (existing) return { instance: existing, created: false };
  const inst = deps.spawn(role.id, label);
  const prompts = {
    connect: `Connect the ${it.title} integration (id \`${it.id}\`). Check its status, ask me for any settings it needs, run the steps, stop at the login gates for me, then verify and propose which agents should use it.`,
    reconnect: `Reconnect the ${it.title} integration (id \`${it.id}\`): check what's failing, repair it (re-run steps, walk me through a new login if needed), and verify.`,
    disconnect: `Disconnect the ${it.title} integration (id \`${it.id}\`). Tell me what that removes and how to revoke its credentials, then disconnect it when I confirm.`,
  };
  deps.send(inst.id, prompts[action]);
  deps.card(inst.id);
  return { instance: inst, created: true };
}

/** A card in a setup chat: the steps of one integration (author "integration", content = its id). */
export function postIntegrationCard(threadId: string, integrationId: string) {
  if (get(`SELECT 1 FROM messages WHERE thread_id = ? AND author = 'integration' AND content = ?`, threadId, integrationId)) return;
  const message = { id: newId(), thread_id: threadId, author: "integration", task_id: null, content: integrationId, created_at: now() };
  run(
    `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
  );
  publish({ type: "message.created", message });
}
