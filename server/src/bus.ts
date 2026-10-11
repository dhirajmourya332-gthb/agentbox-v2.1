import { EventEmitter } from "node:events";
import { now, run } from "./db.ts";

/** Everything the UI needs to stay live goes through here and out over WebSocket. */
export type BusEvent =
  | { type: "agent.created" | "agent.updated"; agent: any }
  | { type: "agent.deleted"; agentId: string }
  | { type: "agent.retired"; agentId: string }
  | { type: "agent.status"; agentId: string; status: AgentStatus; taskId?: string }
  | { type: "task.updated"; task: any }
  | { type: "message.created"; message: any }
  | { type: "turn.delta"; taskId: string; agentId: string; text: string }
  | { type: "step.updated"; step: any }
  | { type: "usage"; usage: any }
  | { type: "skill.updated"; skill: any }
  | { type: "skill.deleted"; name: string }
  | { type: "draft.updated"; draft: any }
  | { type: "agent.skills"; agentId: string; skills: string[] }
  | { type: "thread.created"; thread: any }
  | { type: "group.updated"; group: any }
  | { type: "group.deleted"; id: string }
  | { type: "routine.updated"; routine: any }
  | { type: "routine.deleted"; id: string }
  | { type: "display.updated"; display: any }
  | { type: "paused"; paused: boolean }
  | { type: "devices.changed" } // paired phones or their audit changed (portal Devices page / Activity)
  | { type: "progress.updated"; progress: any } // progress.ts: a running task's live status changed
  | { type: "progress.cleared"; agent_id: string; task_id: string } // its turn ended
  | { type: "attention.updated"; item: any } // attention.ts: a "needs you" item was created, refreshed or seen
  | { type: "routine-run.updated"; run: any } // routineRuns.ts: a routine run started, changed or finished
  | { type: "integration.output"; integrationId: string; taskId: string | null; line: string } // integrations.ts: CLI output
  | { type: "integration.updated"; integrationId: string } // its state may have changed: refetch
  | { type: "integration.job"; integrationId: string; job: any } // a connect / verify / disconnect started or ended
  | { type: "integration.mapping"; integrationId: string; roles: string[] } // role ↔ integration mapping changed
  | { type: "approval.updated"; approval: any }; // approvals.ts: a proposal was made or decided

export type AgentStatus = "idle" | "working" | "limited" | "error";

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// Streaming deltas and live progress are too chatty to keep; everything else is the activity log.
// Run updates are derived state (the run rows and routine.updated already record runs).
const EPHEMERAL = new Set(["turn.delta", "devices.changed", "progress.updated", "progress.cleared", "routine-run.updated",
  "integration.output", "integration.updated"]);

export function publish(event: BusEvent) {
  if (!EPHEMERAL.has(event.type)) {
    const e = event as any;
    run(
      `INSERT INTO events (ts, type, agent_id, task_id, payload) VALUES (?, ?, ?, ?, ?)`,
      now(),
      event.type,
      e.agentId ?? e.agent?.id ?? e.task?.agent_id ?? e.step?.agent_id ?? e.item?.agent_id ?? null,
      e.taskId ?? e.task?.id ?? e.step?.task_id ?? e.message?.task_id ?? e.item?.task_id ?? null,
      JSON.stringify(event),
    );
  }
  emitter.emit("event", event);
}

export function subscribe(fn: (e: BusEvent) => void) {
  emitter.on("event", fn);
  return () => emitter.off("event", fn);
}
