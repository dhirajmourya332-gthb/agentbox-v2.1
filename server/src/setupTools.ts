import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { get } from "./db.ts";
import { getAgent, type Agent } from "./agents.ts";
import {
  integrationAction, integrationStatus, listIntegrations, rolesFor, saveSettings, settingText, type Integration,
} from "./integrations.ts";
import { proposeMapping, proposeTeamRule } from "./approvals.ts";
import { isSetupAgent, postIntegrationCard } from "./setup.ts";

/**
 * The setup agent's MCP tools ("setup", §10.4). Attached only for the setup role (runner.ts); each
 * handler checks that too. They call `agentbox integration …` through integrations.ts; the writes
 * (connect, verify, disconnect, settings) run as root through the setup turn's temporary sudo.
 */

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const ICON: Record<string, string> = { pending: "○", running: "●", human: "⏸", done: "✔", failed: "✖", skipped: "─" };

export function describeStatus(it: Integration) {
  const roles = rolesFor(it.id).map((id) => getAgent(id)?.name ?? id);
  if (!it.available) return `${it.title} (${it.id}) · ${it.category} · coming soon: it can't be connected yet.`;
  const lines = [
    `${it.title} (${it.id}) · ${it.category} · state: ${it.state}${it.account ? ` · account: ${it.account}` : ""}${it.enabled ? "" : " · not enabled"}`,
    `Mapped to: ${roles.join(", ") || "no agents yet"}${it.default_roles.length ? ` (defaults: ${it.default_roles.join(", ")})` : ""}`,
  ];
  if (it.depends.length) lines.push(`Needs: ${it.depends.join(", ")}`);
  if (it.settings.length) {
    lines.push(`Settings${it.settings_saved ? "" : " (never saved)"}:`);
    for (const x of it.settings) {
      const kind = x.type === "enum" && x.options ? `one of ${x.options.join("|")}` : x.type;
      const val = x.value !== null ? settingText(x.value) : x.default !== null ? `(default: ${settingText(x.default)})` : "(not set)";
      lines.push(`  - ${x.key} [${kind}${x.required ? ", required" : ""}]: ${val} · ${x.prompt}${x.example ? ` (e.g. ${x.example})` : ""}${x.error ? ` · INVALID: ${x.error}` : ""}`);
    }
  }
  if (it.steps.length) {
    lines.push("Steps:");
    for (const x of it.steps) {
      lines.push(`  ${ICON[x.state] ?? "?"} ${x.id}: ${x.title} [${x.state}]${x.human ? " (human gate)" : ""}`);
      if (x.last_error) lines.push(`      check failed: ${x.last_error.split("\n").slice(-3).join(" | ")}`);
    }
  }
  if (it.gates.length) {
    lines.push("Waiting for the owner:");
    for (const g of it.gates) {
      if (g.kind === "setting") lines.push(`  - setting ${g.key}: ${g.title} (ask the owner, then save_settings)`);
      else lines.push(`  - ${g.title}: ${(g.instructions ?? "").replace(/\s*\n\s*/g, " ")}${g.copy ? ` [copy: ${g.copy}]` : ""}`);
    }
  }
  if (it.last) lines.push(`Last ${it.last.action}: ${it.last.ok === true ? "ok" : it.last.ok === false ? `failed${it.last.error ? ` (${it.last.error.split("\n").slice(-2).join(" | ")})` : ""}` : "running or interrupted"}${it.last.at ? ` at ${it.last.at}` : ""}`);
  if (it.skills.length) lines.push(`Skills while connected and mapped: ${it.skills.join(", ")}`);
  if (it.revoke) lines.push(`To revoke its credentials (tell the owner on disconnect): ${it.revoke.replace(/\s*\n\s*/g, " ")}`);
  return lines.join("\n");
}

export function setupServer(agent: Agent, taskId: string) {
  return createSdkMcpServer({ name: "setup", version: "1.0.0", tools: setupTools(agent, taskId) });
}

/** The tool definitions (handlers callable directly in tests). */
export function setupTools(agent: Agent, taskId: string) {
  const guard = () => (isSetupAgent(agent) ? null : refuse("These tools are for the setup agent only."));
  const threadId = () => get<{ thread_id: string }>(`SELECT thread_id FROM tasks WHERE id = ?`, taskId)?.thread_id ?? null;
  const card = (id: string) => { const t = threadId(); if (t) postIntegrationCard(t, id); };

  const action = (name: "connect" | "verify" | "disconnect", what: string) =>
    tool(name, what, { id: z.string().describe("integration id, e.g. github") }, async ({ id }) => {
      const no = guard();
      if (no) return no;
      try {
        card(id);
        const r = await integrationAction(name, id, { taskId });
        let after = "";
        try { after = describeStatus(await integrationStatus(id)); } catch (e: any) { after = `(status unavailable: ${e.message})`; }
        const head = r.timedOut ? `${name} ${id}: timed out.` : r.ok ? `${name} ${id}: finished.` : `${name} ${id}: failed (exit ${r.code}).`;
        const out = r.tail.length ? `\nLast output:\n${r.tail.join("\n")}` : "";
        const err = !r.ok && r.stderr.trim() ? `\nErrors:\n${r.stderr.trim().split("\n").slice(-15).join("\n")}` : "";
        const res = `${head}${out}${err}\n\nNow:\n${after}`;
        return r.ok ? text(res) : refuse(res);
      } catch (e: any) {
        return refuse(e.message);
      }
    });

  return [
      tool("list_integrations", "The integration catalog: each one's id, category, state and the agents mapped to it.", {}, async () => {
        const no = guard();
        if (no) return no;
        try {
          const list = await listIntegrations();
          if (!list.length) return text("No integrations in the catalog.");
          const by = new Map<string, Integration[]>();
          for (const it of list) by.set(it.category, [...(by.get(it.category) ?? []), it]);
          return text([...by].map(([cat, items]) => `${cat}:\n${items.map((it) => {
            const roles = rolesFor(it.id).map((id) => getAgent(id)?.name ?? id);
            return `  - ${it.id}: ${it.title} [${it.available ? it.state : "coming soon"}]${roles.length ? ` · used by ${roles.join(", ")}` : ""}`;
          }).join("\n")}`).join("\n"));
        } catch (e: any) {
          return refuse(e.message);
        }
      }),

      tool("integration_status", "One integration's steps with their live check results, its settings and any last errors.",
        { id: z.string().describe("integration id") }, async ({ id }) => {
          const no = guard();
          if (no) return no;
          try {
            const it = await integrationStatus(id);
            card(id);
            return text(describeStatus(it));
          } catch (e: any) {
            return refuse(e.message);
          }
        }),

      action("connect", "Connect an integration: runs its install/configure steps (output streams into the chat) and stops at login gates for the owner. Run again after the owner finished a gate."),
      action("verify", "Run an integration's checks and verify script."),
      action("disconnect", "Disconnect an integration (only after the owner confirmed). Credentials stay; tell the owner how to revoke them."),

      tool("save_settings", "Save settings the owner gave you for an integration. Validated against its schema. Never secrets.",
        {
          id: z.string().describe("integration id"),
          values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
            .describe("setting key → value, e.g. {\"default_repo\": \"acme/web\", \"labels\": [\"bug\", \"feature\"]}; null or \"\" clears one"),
        },
        async ({ id, values }) => {
          const no = guard();
          if (no) return no;
          try {
            const r = await saveSettings(id, values);
            return text(`Saved ${r.saved.join(", ")} for ${id}.${r.missing.length ? ` Still missing (required): ${r.missing.join(", ")}.` : " Nothing required is missing."}`);
          } catch (e: any) {
            return refuse(e.message);
          }
        }),

      tool("propose_mapping", "Propose which agents (roles) use an integration. Shown to the owner as an approval card; applied only when they approve. Replaces the integration's current mapping.",
        {
          id: z.string().describe("integration id"),
          roles: z.array(z.string()).describe("agent names, e.g. [\"tech-lead\", \"coder\"]"),
        },
        async ({ id, roles }) => {
          const no = guard();
          if (no) return no;
          try {
            let title = id;
            try { title = (await listIntegrations({ maxAgeMs: 300_000 })).find((x) => x.id === id)?.title ?? id; } catch { /* id is enough */ }
            const a = proposeMapping(agent, taskId, id, roles, title);
            return text(`Proposed (approval ${a.id}). The owner sees a card in this chat; nothing changes until they approve.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        }),

      tool("propose_team_rule", "Propose a new or changed team-rule file in /team (Markdown). Give the complete new file content; the owner sees the diff as an approval card and it's applied only when they approve.",
        {
          file: z.string().describe("path under /team, e.g. github.md"),
          content: z.string().describe("the complete new content of the file"),
          reason: z.string().optional().describe("one or two sentences: why"),
        },
        async ({ file, content, reason }) => {
          const no = guard();
          if (no) return no;
          try {
            const a = proposeTeamRule(agent, taskId, file, content, reason ?? "");
            return text(`Proposed ${a.payload.relative} (approval ${a.id}). The owner sees the diff in this chat; nothing changes until they approve.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        }),
  ];
}
