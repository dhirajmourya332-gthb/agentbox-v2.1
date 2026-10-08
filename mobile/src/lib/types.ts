/** The subset of the portal's API types (web/src/api.ts) the phone uses. Same JSON. */

export type AgentStatus = "idle" | "working" | "limited" | "error";

export type Agent = {
  id: string;
  slug: string;
  name: string;
  title: string;
  summary: string;
  color: string;
  status: AgentStatus;
  taskId?: string;
  base_agent_id?: string | null;
  can_scale?: number;
  retired_at?: string | null;
  live_instances?: number;
};

export type InstanceSummary = {
  id: string; name: string; label: string | null; role_id: string; color: string; parent_instance_id: string | null;
  created_by: string | null; created_at: string; retired_at: string | null; kept: boolean;
  status: AgentStatus | "done"; current: string | null; queued: number;
};
export type WorkRoom = { root: InstanceSummary; members: InstanceSummary[]; last_activity: string | null; hides_at?: string | null };
export type RoomView = {
  root: InstanceSummary; members: InstanceSummary[]; workspace: string | null; threads: { id: string; agent_id: string; kind: string }[];
  messages: Message[]; tasks: Task[]; steps: Step[];
};
export type RetiredAgent = { id: string; name: string; color: string; base_agent_id: string | null };

export type Message = { id: string; thread_id: string; author: string; task_id: string | null; content: string; created_at: string };
export type Task = {
  id: string; agent_id: string; thread_id: string; source: "user" | "agent" | "message" | "result" | "cron";
  title: string | null; status: "queued" | "running" | "done" | "failed" | "stopped";
  error: string | null; created_at: string; started_at: string | null; finished_at: string | null;
};
export type Step = {
  id: string; task_id: string; seq: number; kind: string; name: string; summary: string;
  status: "running" | "done" | "error" | "stopped"; started_at: string; finished_at: string | null;
};
export type Group = { id: string; name: string; paused: boolean };
export type RoutineRun = {
  id: string; at: string; trigger: "schedule" | "manual"; outcome: "started" | "skipped"; reason: string | null;
  task_id: string | null; task_status: string | null; task_error?: string | null;
};
export type Routine = {
  id: string; agent_id: string; name: string; cron: string; timezone: string; enabled: boolean;
  next_runs: string[]; describe: string; last_run: RoutineRun | null;
};
export type DisplayHolder = { holder: string; reason: string; since: string } | null;
export type ThreadData = { messages: Message[]; tasks: Task[]; steps: Step[] };
export type Usage = { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number };
