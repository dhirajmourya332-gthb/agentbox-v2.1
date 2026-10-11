import type { ModuleDef } from "./manifest.ts";
import { applicableSteps } from "./roadmap.ts";

/**
 * The setup agent (docs/SETUP-PLAN.md § 3, step 3): a Claude Code session through the Agent SDK
 * that installs, configures and verifies the profile's modules by running the module scripts. It
 * never performs logins and never handles secrets: at a human gate it says what to run and ends its
 * turn; the guide sends "continue" when the gate's check turns green.
 *
 * The session id is persisted (resume after a guide restart or a Pause). A turn that a guide
 * restart cut off is resumed by the guide with RESUME_PROMPT (app.ts).
 */

export type AgentStatus = "idle" | "running" | "waiting" | "paused";
export type LogEntry = { id: number; at: number; kind: "text" | "tool" | "output" | "info" | "error" | "done"; text: string };
export type Usage = { status?: string; resetsAt?: number; utilization?: number; rateLimitType?: string; costUsd?: number };

/** The SDK's query(): injected so tests can run the wiring without Claude. */
export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any> & { interrupt?: () => Promise<unknown> };

/** Commands the setup agent must never run (it would be doing a login, handling a secret or using Docker). */
const FORBIDDEN: [RegExp, string][] = [
  [/(^|[\s;&|(`])(sudo\s+)?docker(\s|$)|\bdocker\.io\b|\bpodman\b/, "Docker is not used by agentbox setup."],
  [/\bgh\s+auth\s+(login|refresh|token)\b/, "Logins are the owner's turn: tell them to run it in the terminal."],
  [/\bclaude\s+(\/login|setup-token|login)\b/, "Logins are the owner's turn."],
  [/\b(tailscale\s+up|tailscale-up\.sh|cloudflared(\s+tunnel)?\s+login|cloudflared-login\.sh)\b/, "Logins are the owner's turn."],
  [/\baws\s+(configure|sso\s+login)\b/, "AWS credentials are the owner's turn."],
  [/\b(glab\s+auth\s+login|gcloud\s+auth\s+(login|application-default\s+login)|az\s+login)\b/, "Logins are the owner's turn."],
  [/\bagentbox\s+integration\s+(connect|disconnect)\b/, "The first run sets up the base only. Integrations are connected later from the portal (Setup agent or Integrations)."],
  [/\beas\s+login\b/, "Logins are the owner's turn."],
  [/\bagentbox\s+secret\s+set\b/, "Secrets are entered by the owner in the terminal, never by the agent."],
  [/\bagentbox\s+guide\b/, "The guide is already running."],
  [/(cat|less|more|head|tail|grep|base64|xxd|od|cp|scp|curl)\b[^|;&]*\/(secrets|etc\/agentbox\/(ttyd\.credential|vnc\.password)|etc\/cloudflared)\b/, "Don't read secrets."],
  [/\.claude\/\.credentials\.json|local-token\b/, "Don't read credentials."],
];

export function forbiddenReason(cmd: string): string | null {
  for (const [re, why] of FORBIDDEN) if (re.test(cmd)) return why;
  return null;
}

/** A compact, model-friendly rendering of the manifests in the profile. */
export function manifestText(mods: ModuleDef[], order: string[], conf: any) {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const out: string[] = [];
  for (const id of order) {
    const m = byId.get(id);
    if (!m) continue;
    out.push(`## ${m.id}: ${m.title}${m.depends.length ? ` (depends on: ${m.depends.join(", ")})` : ""}`);
    if (m.description) out.push(m.description);
    for (const s of applicableSteps(m, conf)) {
      out.push(`- step ${s.id}${s.human ? " [HUMAN GATE]" : ""}: ${s.title}`);
      if (s.run) out.push(`  run: ${s.run}`);
      if (s.check) out.push(`  check: ${s.check}`);
      if (s.human && s.instructions) out.push(`  instructions for the owner:\n${s.instructions.trim().split("\n").map((l) => `    ${l}`).join("\n")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function systemPrompt(mods: ModuleDef[], order: string[], conf: any) {
  return `You are the agentbox SETUP AGENT. You run on the VM being set up, as the agent user (${conf?.user ?? "agentbox"}), with passwordless sudo for the duration of setup. The owner watches you in the setup guide: a terminal on the left, a roadmap on the right that ticks steps off when their checks pass.

RULES
- The first run sets up the BASE only (the modules below: core, Claude Code, access, display, terminal). Integrations (GitHub, GitLab, Bitbucket, AWS, Google Cloud, Azure, Kubernetes…) are not part of it: the owner connects them later from the portal. Never run \`agentbox integration connect\`; if the owner asks for one, tell them it's the next step after Finish.
- Install, configure and verify modules in dependency order by running the module scripts via \`sudo agentbox module install <id>\` and \`agentbox module verify <id>\` (\`agentbox module check <id>\` shows the checks). Install one module per command so the roadmap can follow you.
- A step is done ONLY when its check passes. Never claim a step is done; run the check (or \`agentbox module check <id>\`) to see.
- You never perform logins and never handle secrets: no \`claude /login\`, \`gh auth login\`, \`tailscale up\`, \`cloudflared login\`, \`aws configure\`, \`eas login\`, no \`agentbox secret set\`, and never read /secrets, credential files or tokens.
- When the next step is a HUMAN GATE, stop and tell the owner exactly what to run (copy the step's instructions), then end your turn. The guide restarts you with "continue" when the gate's check turns green. Don't wait, poll or sleep for it.
- Steps after a human gate in the same module usually need that gate; move on to the next module that doesn't depend on a waiting one, or end your turn.
- Don't run Docker. Don't change the access mode or turn modules on or off: the owner chose the access mode in the guide.
- If a script fails, read its output, diagnose (logs: \`journalctl -u <unit> -n 50\`), fix what is clearly safe to fix (e.g. a missing package, a stopped service), retry once, and otherwise explain the problem to the owner and end your turn.
- Be brief. Say which module you're on, what you ran and what happened. No long explanations.
- When every step in the profile is done, say so and end your turn; the guide runs the security self-test.

CONFIG
host: ${conf?.host} · access: ${conf?.access} · user: ${conf?.user}

PROFILE (dependency order)
${order.join(", ")}

MODULES
${manifestText(mods, order, conf)}`;
}

export type AgentDeps = {
  query: QueryFn;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The system prompt for a new turn (built from the current profile). */
  prompt: () => string;
  loadSession: () => string | null;
  saveSession: (id: string | null) => void;
  onLog: (e: LogEntry) => void;
  onStatus: (s: AgentStatus) => void;
  onUsage: (u: Usage) => void;
  /** A Bash command started / finished (to follow which module the agent is working on). */
  onTool?: (ev: { phase: "start" | "end"; id: string; command: string; isError?: boolean; output?: string }) => void;
  /** Any message from the SDK (the page's "no news for N s" heartbeat). */
  onActivity?: () => void;
  /** How a turn ended: finished (a result came back), error (the SDK threw), paused. */
  onTurnEnd?: (how: "finished" | "error" | "paused") => void;
  /** Whether a human gate is open after a turn ends (→ "waiting" instead of "idle"). */
  gateOpen: () => boolean;
  model?: string;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const tail = (s: string, lines: number) => {
  const l = s.trimEnd().split("\n");
  return l.length > lines ? [`… (${l.length - lines} more lines)`, ...l.slice(-lines)].join("\n") : l.join("\n");
};

export function createSetupAgent(d: AgentDeps) {
  let status: AgentStatus = "idle";
  let abort: AbortController | null = null;
  let current: ReturnType<QueryFn> | null = null;
  let seq = 0;
  let pausedFlag = false;
  const toolCmd = new Map<string, string>();

  const set = (s: AgentStatus) => { if (s !== status) { status = s; d.onStatus(s); } };
  const log = (kind: LogEntry["kind"], text: string) => d.onLog({ id: ++seq, at: Date.now(), kind, text });

  const guard = async (input: any) => {
    if (input?.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const why = forbiddenReason(String(input.tool_input?.command ?? ""));
    if (!why) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } };
  };

  function handle(msg: any, textBuf: { s: string }) {
    d.onActivity?.();
    switch (msg?.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) d.saveSession(msg.session_id);
        break;
      case "stream_event":
        if (msg.parent_tool_use_id) break;
        if (msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") textBuf.s += msg.event.delta.text;
        break;
      case "assistant":
        if (msg.parent_tool_use_id) break;
        for (const b of msg.message?.content ?? []) {
          if (b.type === "text" && b.text?.trim()) { log("text", b.text.trim()); textBuf.s = ""; }
          if (b.type === "tool_use") {
            const cmd = b.name === "Bash" ? String(b.input?.command ?? "") : "";
            if (cmd) { toolCmd.set(b.id, cmd); d.onTool?.({ phase: "start", id: b.id, command: cmd }); }
            log("tool", cmd ? `$ ${clip(cmd, 600)}` : `${b.name} ${clip(JSON.stringify(b.input ?? {}), 300)}`);
          }
        }
        break;
      case "user":
        if (msg.parent_tool_use_id || !Array.isArray(msg.message?.content)) break;
        for (const b of msg.message.content) {
          if (b.type !== "tool_result") continue;
          const text = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n") : "";
          const cmd = toolCmd.get(b.tool_use_id);
          if (cmd !== undefined) { toolCmd.delete(b.tool_use_id); d.onTool?.({ phase: "end", id: b.tool_use_id, command: cmd, isError: !!b.is_error, output: text }); }
          if (text.trim()) log(b.is_error ? "error" : "output", tail(text, 12));
        }
        break;
      case "rate_limit_event":
        if (msg.rate_limit_info) d.onUsage({ ...msg.rate_limit_info });
        break;
      case "result":
        if (msg.session_id) d.saveSession(msg.session_id);
        if (typeof msg.total_cost_usd === "number") d.onUsage({ costUsd: msg.total_cost_usd });
        return msg;
    }
    return undefined;
  }

  async function turn(prompt: string) {
    if (status === "running") return false;
    pausedFlag = false;
    set("running");
    log("info", prompt === START_PROMPT ? "setup agent started" : `→ ${clip(prompt, 200)}`);
    const run = async (resume: string | undefined) => {
      abort = new AbortController();
      const textBuf = { s: "" };
      const q = d.query({
        prompt,
        options: {
          cwd: d.cwd,
          resume,
          abortController: abort,
          includePartialMessages: true,
          settingSources: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          strictMcpConfig: true,
          mcpServers: {},
          maxTurns: 300,
          ...(d.model ? { model: d.model } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: d.prompt() },
          env: d.env,
          hooks: { PreToolUse: [{ hooks: [guard] }] },
        },
      });
      current = q;
      let result: any;
      for await (const m of q) result = handle(m, textBuf) ?? result;
      return result;
    };
    try {
      let result: any;
      const resume = d.loadSession() ?? undefined;
      try {
        result = await run(resume);
      } catch (e: any) {
        // A session whose transcript is gone can't be resumed: start a fresh one.
        if (resume && !abort?.signal.aborted && /session|conversation/i.test(String(e?.message))) {
          d.saveSession(null);
          result = await run(undefined);
        } else throw e;
      }
      if (pausedFlag) { d.onTurnEnd?.("paused"); log("info", "paused"); set("paused"); return true; }
      d.onTurnEnd?.("finished");
      if (result?.subtype && result.subtype !== "success") log("error", `the turn ended: ${result.subtype}`);
      else log("done", "turn finished");
    } catch (e: any) {
      if (pausedFlag) { d.onTurnEnd?.("paused"); log("info", "paused"); set("paused"); return true; }
      d.onTurnEnd?.("error");
      log("error", `the setup agent stopped: ${clip(String(e?.message ?? e), 500)}`);
    } finally {
      current = null;
      abort = null;
      for (const [id, command] of toolCmd) d.onTool?.({ phase: "end", id, command, isError: true, output: "interrupted" });
      toolCmd.clear();
    }
    if (!pausedFlag) set(d.gateOpen() ? "waiting" : "idle");
    return true;
  }

  return {
    get status() { return status; },
    /** Start (or continue) a turn. Returns false when one is already running. */
    start(prompt?: string) { return turn(prompt ?? (d.loadSession() ? "continue" : START_PROMPT)); },
    /** Stop the current turn; nothing restarts it until resume(). */
    async pause() {
      pausedFlag = true;
      if (status !== "running") { set("paused"); return; }
      try { await current?.interrupt?.(); } catch { /* fall through to abort */ }
      abort?.abort();
    },
    resume(prompt = "continue") { pausedFlag = false; set("idle"); return turn(prompt); },
    /** The guide calls this when a human gate's check turns green. */
    gateGreen(title: string) {
      if (status === "waiting") return turn(`continue: "${title}" is done (its check passed).`);
      return Promise.resolve(false);
    },
    /** No gate is open any more (e.g. the owner switched the module off): stop waiting. */
    gatesClosed() { if (status === "waiting") set("idle"); },
    /**
     * After a guide restart: a paused agent stays paused, a waiting one keeps waiting for its gate.
     * One that was running is idle here; the guide resumes it (RESUME_PROMPT) once the checks are in.
     */
    restoreStatus(s: AgentStatus) {
      if (s === "paused") { pausedFlag = true; set("paused"); }
      else if (s === "waiting") set("waiting");
    },
  };
}

export const START_PROMPT =
  "Set up the modules in the profile, in dependency order, following the rules. Start by running `agentbox module check` for each module to see what is already done, then install what's missing.";

/** Sent to the saved session when the guide restarted in the middle of a turn. */
export const RESUME_PROMPT =
  "continue: the setup guide restarted while you were working, so your last command may have been cut off. Check where things stand (`agentbox module check <id>` for the module you were on), re-run what didn't finish, and carry on.";

export type SetupAgent = ReturnType<typeof createSetupAgent>;
