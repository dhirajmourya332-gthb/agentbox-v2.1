import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
import path from "node:path";
import { all, get, newId, now, run } from "./db.ts";
import { publish, type AgentStatus } from "./bus.ts";
import { getAgent, homeOf, WORK_ROOT, type Agent } from "./agents.ts";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_MCP = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
const CDP_ENDPOINT = process.env.AGENTBOX_CDP ?? "http://127.0.0.1:9222";

// ---------------------------------------------------------------------------
// Status and usage, kept in memory and pushed to the UI.

const statuses = new Map<string, { status: AgentStatus; taskId?: string }>();
export const agentStatus = (id: string) => statuses.get(id) ?? { status: "idle" as AgentStatus };

function setStatus(agentId: string, status: AgentStatus, taskId?: string) {
  statuses.set(agentId, { status, taskId });
  publish({ type: "agent.status", agentId, status, taskId });
}

// Last subscription usage reading; survives restarts via the events log.
let usage: any = (() => {
  const row = get(`SELECT payload FROM events WHERE type = 'usage' ORDER BY id DESC LIMIT 1`);
  return row ? JSON.parse(row.payload).usage : null;
})();
export const currentUsage = () => usage;

// ---------------------------------------------------------------------------
// Queue: one turn at a time per agent, in arrival order.

const chains = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

const taskRow = (id: string) => get(`SELECT * FROM tasks WHERE id = ?`, id);

export function sendMessage(agentId: string, threadId: string, text: string) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error("No such agent");

  const task = {
    id: newId(), agent_id: agentId, thread_id: threadId, source: "user", prompt: text,
    status: "queued", created_at: now(),
  };
  run(
    `INSERT INTO tasks (id, agent_id, thread_id, source, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    task.id, task.agent_id, task.thread_id, task.source, task.prompt, task.status, task.created_at,
  );
  const message = { id: newId(), thread_id: threadId, author: "user", task_id: task.id, content: text, created_at: now() };
  run(
    `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
  );
  publish({ type: "message.created", message });
  publish({ type: "task.updated", task: taskRow(task.id) });

  const next = (chains.get(agentId) ?? Promise.resolve()).then(() => runTask(task.id)).catch((err) => {
    console.error("task crashed", task.id, err);
  });
  chains.set(agentId, next);
  return { message, task };
}

export function stopTask(taskId: string) {
  const t = taskRow(taskId);
  if (!t) throw new Error("No such task");
  if (t.status === "queued") {
    finishTask(taskId, { status: "stopped" });
  } else {
    aborts.get(taskId)?.abort();
  }
}

function finishTask(taskId: string, f: { status: string; result?: string; error?: string; cost?: number }) {
  run(
    `UPDATE tasks SET status = ?, result = ?, error = ?, cost_usd = ?, finished_at = ? WHERE id = ?`,
    f.status, f.result ?? null, f.error ?? null, f.cost ?? null, now(), taskId,
  );
  publish({ type: "task.updated", task: taskRow(taskId) });
}

// ---------------------------------------------------------------------------
// Running one turn.

function systemAppend(agent: Agent) {
  return `
# agentbox

You are **${agent.name}** (${agent.title}), one agent on a team that shares a single Linux
computer (the agentbox VM). Your role and job description are in CLAUDE.md in your home
directory; follow them.

## Your computer
- Home: ${homeOf(agent)} (yours alone). Shared work area: ${WORK_ROOT} (repos live here; use a
  separate git worktree for each piece of work so you don't disturb other agents).
- Full control: passwordless sudo, docker, and these CLIs already signed in as the owner:
  gh (GitHub), aws, claude. Do not log them out or change their accounts.
- Shared screen: X display :99, watched live by the owner. A shared Chromium runs on it with
  the owner's web logins (e.g. Microsoft Teams). Drive it with the \`browser\` tools.
  Other agents use this browser too: open your own tab for your work and close it when done.
  To open a URL from the shell use \`agentbox-open <url>\`.
- Other GUI apps: \`xdotool\` for input, \`scrot /tmp/s.png\` then Read the image to see the screen.

## Memory
Your memory lives in ${homeOf(agent)}/memory/ with MEMORY.md as the index. Read the index when
a task may depend on past work. When you learn something durable (a preference, a decision,
how a system works), save it as a short file there and add a line to MEMORY.md.

## Reporting
The owner reads your replies in a chat UI. Lead with the outcome, then the key details
(links to PRs, files changed, what you verified). Keep it short. If you are blocked or need a
decision, say exactly what you need.
`.trim();
}

type Step = { id: string; task_id: string; agent_id: string; seq: number; kind: string; name: string;
  summary: string; input: string; output: string | null; status: string; started_at: string; finished_at: string | null };

function classify(name: string, input: any): { kind: string; label: string; summary: string } {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const first = (s: string) => s.split("\n")[0].slice(0, 200);
  if (name === "Bash") return { kind: "shell", label: "Shell", summary: first(str(input?.command)) };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name))
    return { kind: "edit", label: name, summary: str(input?.file_path ?? input?.notebook_path) };
  if (name === "Read") return { kind: "read", label: "Read", summary: str(input?.file_path) };
  if (name === "Glob" || name === "Grep") return { kind: "search", label: name, summary: str(input?.pattern) };
  if (name.startsWith("mcp__browser__")) {
    const action = name.slice("mcp__browser__".length).replace(/^browser_/, "").replace(/_/g, " ");
    return { kind: "browser", label: "Browser", summary: [action, str(input?.url) || str(input?.element) || str(input?.text)].filter(Boolean).join(" · ") };
  }
  if (name === "WebFetch" || name === "WebSearch") return { kind: "web", label: name, summary: str(input?.url ?? input?.query) };
  if (name === "TodoWrite") return { kind: "plan", label: "Plan", summary: `${(input?.todos ?? []).length} items` };
  if (name === "Task" || name === "Agent") return { kind: "agent", label: "Subagent", summary: first(str(input?.description ?? input?.prompt)) };
  if (name === "ToolSearch") return { kind: "meta", label: "Tool search", summary: str(input?.query) };
  return { kind: "tool", label: name, summary: first(JSON.stringify(input ?? {})) };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

async function runTask(taskId: string) {
  const task = taskRow(taskId);
  if (!task || task.status !== "queued") return;
  const agent = getAgent(task.agent_id);
  if (!agent) return finishTask(taskId, { status: "failed", error: "Agent was deleted" });

  run(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`, now(), taskId);
  publish({ type: "task.updated", task: taskRow(taskId) });
  setStatus(agent.id, "working", taskId);

  const abort = new AbortController();
  aborts.set(taskId, abort);

  const steps = new Map<string, Step>(); // by tool_use_id
  const texts: string[] = [];
  let seq = 0;
  let streamed = false;
  let liveText = ""; // what the owner has seen stream in, kept if the turn is stopped
  let sessionId: string | undefined =
    get(`SELECT session_id FROM agent_sessions WHERE agent_id = ? AND thread_id = ?`, agent.id, task.thread_id)?.session_id;

  const saveSession = (id: string) => {
    sessionId = id;
    run(
      `INSERT INTO agent_sessions (agent_id, thread_id, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (agent_id, thread_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      agent.id, task.thread_id, id, now(),
    );
  };

  const saveStep = (s: Step) => {
    run(
      `INSERT INTO steps (id, task_id, seq, kind, name, summary, input, output, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET output = excluded.output, status = excluded.status, finished_at = excluded.finished_at`,
      s.id, s.task_id, s.seq, s.kind, s.name, s.summary, s.input, s.output, s.status, s.started_at, s.finished_at,
    );
    publish({ type: "step.updated", step: s });
  };

  const handle = (m: SDKMessage) => {
    const msg = m as any;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) saveSession(msg.session_id);
        break;
      case "stream_event":
        if (msg.parent_tool_use_id !== null) break;
        // Separate text blocks the same way the final message joins them.
        if (msg.event?.type === "content_block_start" && msg.event.content_block?.type === "text" && streamed) {
          liveText += "\n\n";
          publish({ type: "turn.delta", taskId, agentId: agent.id, text: "\n\n" });
        }
        if (msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
          streamed = true;
          liveText += msg.event.delta.text;
          publish({ type: "turn.delta", taskId, agentId: agent.id, text: msg.event.delta.text });
        }
        break;
      case "assistant":
        if (msg.parent_tool_use_id !== null) break;
        for (const b of msg.message.content ?? []) {
          if (b.type === "text" && b.text.trim()) texts.push(b.text);
          if (b.type === "tool_use") {
            const c = classify(b.name, b.input);
            const step: Step = {
              id: b.id, task_id: taskId, agent_id: agent.id, seq: seq++, kind: c.kind, name: c.label,
              summary: c.summary, input: clip(JSON.stringify(b.input ?? {}, null, 2), 8000), output: null,
              status: "running", started_at: now(), finished_at: null,
            };
            steps.set(b.id, step);
            saveStep(step);
          }
        }
        break;
      case "user":
        if (msg.parent_tool_use_id !== null || !Array.isArray(msg.message?.content)) break;
        for (const b of msg.message.content) {
          if (b.type !== "tool_result") continue;
          const step = steps.get(b.tool_use_id);
          if (!step) continue;
          step.output = clip(resultText(b.content), 8000);
          step.status = b.is_error ? "error" : "done";
          step.finished_at = now();
          saveStep(step);
        }
        break;
      case "rate_limit_event":
        usage = { ...msg.rate_limit_info, at: now() };
        publish({ type: "usage", usage });
        if (msg.rate_limit_info?.status === "rejected") setStatus(agent.id, "limited", taskId);
        break;
      case "result":
        if (msg.session_id) saveSession(msg.session_id);
        return msg;
    }
    return undefined;
  };

  const runOnce = async (resume: string | undefined) => {
    const q = query({
      prompt: task.prompt,
      options: {
        cwd: homeOf(agent),
        model: agent.model,
        maxTurns: agent.max_turns,
        resume,
        abortController: abort,
        includePartialMessages: true,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        strictMcpConfig: true,
        mcpServers: {
          browser: { type: "stdio", command: process.execPath, args: [PLAYWRIGHT_MCP, "--cdp-endpoint", CDP_ENDPOINT] },
        },
        systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend(agent) },
        env: { ...process.env, DISPLAY: ":99", BROWSER: "/usr/local/bin/agentbox-open" },
      },
    });
    let result: any;
    for await (const m of q) result = handle(m) ?? result;
    return result;
  };

  try {
    let result: any;
    try {
      result = await runOnce(sessionId);
    } catch (err: any) {
      // A session whose transcript is gone can't be resumed: start a fresh one.
      if (sessionId && !abort.signal.aborted && /session|conversation/i.test(String(err?.message))) {
        result = await runOnce(undefined);
      } else {
        throw err;
      }
    }
    if (abort.signal.aborted && result?.subtype !== "success") throw new Error("aborted");
    const content = texts.join("\n\n") || result?.result || "";
    postAgentMessage(agent, task, content);
    finishTask(taskId, {
      status: result?.subtype === "success" ? "done" : "failed",
      result: content,
      error: result?.subtype === "success" ? undefined : String(result?.subtype ?? "unknown"),
      cost: result?.total_cost_usd,
    });
    setStatus(agent.id, "idle");
  } catch (err: any) {
    for (const s of steps.values()) {
      if (s.status === "running") saveStep({ ...s, status: abort.signal.aborted ? "stopped" : "error", finished_at: now() });
    }
    const stopped = abort.signal.aborted;
    const partial = liveText.length > texts.join("\n\n").length ? liveText : texts.join("\n\n");
    if (partial.trim()) postAgentMessage(agent, task, partial);
    finishTask(taskId, { status: stopped ? "stopped" : "failed", error: stopped ? undefined : String(err?.message ?? err) });
    const limited = /rate.?limit|usage limit/i.test(String(err?.message));
    setStatus(agent.id, stopped ? "idle" : limited ? "limited" : "error");
  } finally {
    aborts.delete(taskId);
  }
}

function postAgentMessage(agent: Agent, task: any, content: string) {
  const message = { id: newId(), thread_id: task.thread_id, author: agent.id, task_id: task.id, content, created_at: now() };
  run(
    `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
  );
  publish({ type: "message.created", message });
}

export function threadView(threadId: string) {
  const messages = all(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid`, threadId);
  const tasks = all(`SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at`, threadId);
  const steps = all(
    `SELECT steps.* FROM steps JOIN tasks ON tasks.id = steps.task_id WHERE tasks.thread_id = ? ORDER BY steps.seq`,
    threadId,
  );
  return { messages, tasks, steps };
}

export function resetSession(agentId: string, threadId: string) {
  run(`DELETE FROM agent_sessions WHERE agent_id = ? AND thread_id = ?`, agentId, threadId);
}
