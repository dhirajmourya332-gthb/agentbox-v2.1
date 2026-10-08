export type AgentStatus = "idle" | "working" | "limited" | "error";

export type Agent = {
  id: string;
  slug: string;
  name: string;
  title: string;
  summary: string;
  model: string;
  color: string;
  max_turns: number;
  created_at: string;
  status: AgentStatus;
  taskId?: string;
  dm_thread_id: string | null;
  skills: string[];
  home?: string;
  /** Instances only: */
  created_by?: string | null;
  parent_instance_id?: string | null;
  label?: string | null;
  kept?: number;
  /** Agents (roles) only: how many live tasks they have. */
  live_instances?: number;
  base_agent_id?: string | null;
  replica_no?: number | null;
  max_replicas?: number;
  can_scale?: number;
  retired_at?: string | null;
};
export type DocumentInfo = {
  path: string; name: string; folder: string; location: string; size: number; modified: string;
  source: "home" | "written"; task_id: string | null; task_title: string | null;
};
export const fileUrl = (path: string, download = false) =>
  `/api/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
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

export type Skill = { name: string; description: string; body: string; files: string[]; agents: string[]; updated_at: string };
export type SkillDraft = {
  id: string; name: string; description: string; body: string; proposed_by: string; task_id: string | null;
  status: "pending" | "approved" | "rejected"; created_at: string;
};

export type Message = { id: string; thread_id: string; author: string; task_id: string | null; content: string; created_at: string };
export type Task = {
  id: string; agent_id: string; thread_id: string; source: "user" | "agent" | "message" | "result" | "cron"; prompt?: string;
  title: string | null; from_agent_id: string | null; parent_task_id: string | null; depth: number; children?: number;
  status: "queued" | "running" | "done" | "failed" | "stopped";
  result?: string | null; error: string | null; cost_usd?: number | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};
export type Step = {
  id: string; task_id: string; seq: number; kind: string; name: string; summary: string;
  input: string | null; output: string | null; status: "running" | "done" | "error" | "stopped";
  started_at: string; finished_at: string | null;
};
export type Group = {
  id: string; name: string; purpose: string; lead_agent_id: string | null; members: string[]; paused: boolean; created_at: string;
};
export type Thread = { id: string; kind: "dm" | "handoff" | "group" | "routine"; agent_id: string; peer_agent_id: string | null; name: string | null; last_at: string | null };
export type RoutineRun = { id: string; at: string; trigger: "schedule" | "manual"; outcome: "started" | "skipped"; reason: string | null; task_id: string | null; task_status: string | null; task_error?: string | null };
export type Routine = {
  id: string; agent_id: string; thread_id: string; name: string; cron: string; timezone: string; prompt: string;
  enabled: boolean; created_by: string; created_at: string; next_runs: string[]; describe: string; last_run: RoutineRun | null;
  instance_id: string | null; context_mode: "continue" | "fresh"; workspace: string | null;
  group: { id: string; name: string; label: string | null; role_id: string; context_tokens: number | null }[];
  compaction: { runs_since: number; last_at: string | null; context_tokens: number; due: string[] };
};
export type DisplayHolder = { holder: string; reason: string; since: string; last_used: string; task_id: string | null } | null;
export type ActivityItem = {
  id: string; ts: string; kind: string; actor: string; agent_id: string | null; title: string; detail?: string; task_id?: string | null; link?: string;
};
export type GraphEdge = { from: string; to: string; kind: string; n: number; last: string };
export type RoutineInput = { agent_id: string; name: string; cron: string; timezone: string; prompt: string; enabled: boolean; context_mode?: "continue" | "fresh" };
export type ThreadData = { messages: Message[]; tasks: Task[]; steps: Step[] };

export type Usage = {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Record<string, { utilization: number; resetsAt: number }>;
};

export type CoreQuestion = { id: string; question: string; hint: string; kind: "short" | "long" | "multi"; options?: string[] };
export type Template = { id: string; label: string; name: string; job: string; done: string };
export type FollowUp = { id: string; question: string; options: string[] };
export type Draft = { title: string; summary: string; model: string; model_reason: string; instructions: string };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  state: () => call<{ agents: Agent[]; usage: Usage | null; groups: Group[]; paused: boolean; display: DisplayHolder; retired: RetiredAgent[] }>("GET", "/api/state"),
  fileInfo: (path: string) => call<Pick<DocumentInfo, "path" | "name" | "folder" | "size" | "modified">>("GET", `/api/file/info?path=${encodeURIComponent(path)}`),
  work: () => call<{ live: WorkRoom[]; done: WorkRoom[] }>("GET", "/api/work"),
  newTask: (roleId: string, text: string, title?: string) => call<Agent>("POST", "/api/work", { role_id: roleId, text, title }),
  room: (rootId: string) => call<RoomView>("GET", `/api/work/${rootId}`),
  roomDocuments: (rootId: string) => call<(DocumentInfo & { author: string | null })[]>("GET", `/api/work/${rootId}/documents`),
  groupDocuments: (groupId: string) => call<(DocumentInfo & { author: string | null })[]>("GET", `/api/groups/${groupId}/documents`),
  allDocuments: () => call<(DocumentInfo & { role: string })[]>("GET", "/api/documents"),
  finishTask: (instanceId: string) => call<{ finished: number }>("POST", `/api/agents/${instanceId}/done`),
  setTaskMeta: (instanceId: string, meta: { label?: string; kept?: boolean }) => call<Agent>("PATCH", `/api/agents/${instanceId}/meta`, meta),
  documents: (agentId: string) => call<DocumentInfo[]>("GET", `/api/agents/${agentId}/documents`),
  spawnReplica: (baseId: string) => call<Agent>("POST", `/api/agents/${baseId}/replicas`),
  retireReplica: (id: string) => call("POST", `/api/agents/${id}/retire`),
  pauseAll: (stopRunning: boolean) => call("POST", "/api/pause", { stopRunning }),
  resumeAll: () => call("POST", "/api/resume"),
  control: () => call<{ paused: boolean; display: DisplayHolder; running: number }>("GET", "/api/control"),
  takeDisplay: () => call("POST", "/api/display/take"),
  releaseDisplay: () => call("POST", "/api/display/release"),
  activity: (agent?: string) => call<ActivityItem[]>("GET", `/api/activity${agent ? `?agent=${agent}` : ""}`),
  graph: (since: string) => call<{ edges: GraphEdge[] }>("GET", `/api/graph?since=${encodeURIComponent(since)}`),
  health: () => call<any>("GET", "/api/health"),
  interview: () => call<{ questions: CoreQuestion[]; templates: Template[] }>("GET", "/api/interview"),
  followUps: (answers: Record<string, unknown>) =>
    call<{ questions: FollowUp[] }>("POST", "/api/interview/follow-ups", { answers }),
  draft: (answers: Record<string, unknown>, extra: FollowUp[]) =>
    call<Draft>("POST", "/api/interview/draft", { answers, extra }),
  createAgent: (body: { name: string; title: string; summary: string; model: string; instructions: string; interview: unknown; skills: string[] }) =>
    call<Agent>("POST", "/api/agents", body),
  agent: (id: string) =>
    call<{ agent: Agent; instructions: string; memory: { file: string; content: string }[] }>("GET", `/api/agents/${id}`),
  updateAgent: (id: string, patch: Partial<Pick<Agent, "title" | "summary" | "model" | "max_turns" | "max_replicas">> & { can_scale?: boolean }) =>
    call<Agent>("PATCH", `/api/agents/${id}`, patch),
  saveInstructions: (id: string, text: string) => call("PUT", `/api/agents/${id}/instructions`, { text }),
  deleteAgent: (id: string) => call("DELETE", `/api/agents/${id}`),
  resetSession: (id: string) => call("POST", `/api/agents/${id}/reset-session`),
  setAgentSkills: (id: string, skills: string[]) => call<Agent>("PUT", `/api/agents/${id}/skills`, { skills }),
  skills: () => call<{ skills: Skill[]; drafts: SkillDraft[] }>("GET", "/api/skills"),
  skill: (name: string) => call<Skill>("GET", `/api/skills/${name}`),
  createSkill: (b: { name: string; description: string; body: string; agents: string[] }) => call<Skill>("POST", "/api/skills", b),
  updateSkill: (name: string, b: { description: string; body: string; agents: string[] }) => call<Skill>("PUT", `/api/skills/${name}`, b),
  deleteSkill: (name: string) => call("DELETE", `/api/skills/${name}`),
  skillDraft: (id: string) => call<{ draft: SkillDraft; existing: Skill | null }>("GET", `/api/skill-drafts/${id}`),
  approveDraft: (id: string, b: { name: string; description: string; body: string; agents: string[] }) =>
    call("POST", `/api/skill-drafts/${id}/approve`, b),
  rejectDraft: (id: string) => call("POST", `/api/skill-drafts/${id}/reject`),
  tasks: () => call<Task[]>("GET", "/api/tasks"),
  task: (id: string) => call<{ task: Task; tree: Task[]; steps: Step[] }>("GET", `/api/tasks/${id}`),
  agentThreads: (id: string) => call<Thread[]>("GET", `/api/agents/${id}/threads`),
  createGroup: (b: { name: string; purpose: string; members: string[]; lead: string | null }) => call<Group>("POST", "/api/groups", b),
  updateGroup: (id: string, b: { name: string; purpose: string; members: string[]; lead: string | null }) => call<Group>("PUT", `/api/groups/${id}`, b),
  deleteGroup: (id: string) => call("DELETE", `/api/groups/${id}`),
  continueGroup: (id: string) => call("POST", `/api/groups/${id}/continue`),
  routines: () => call<Routine[]>("GET", "/api/routines"),
  routine: (id: string) => call<{ routine: Routine; runs: RoutineRun[] }>("GET", `/api/routines/${id}`),
  createRoutine: (b: RoutineInput) => call<Routine>("POST", "/api/routines", b),
  updateRoutine: (id: string, b: RoutineInput) => call<Routine>("PUT", `/api/routines/${id}`, b),
  deleteRoutine: (id: string) => call("DELETE", `/api/routines/${id}`),
  compactRoutine: (id: string) => call("POST", `/api/routines/${id}/compact`),
  freshRoutine: (id: string) => call("POST", `/api/routines/${id}/fresh`),
  runRoutine: (id: string) => call<{ started: boolean; routine: Routine }>("POST", `/api/routines/${id}/run`),
  previewCron: (cron: string, timezone: string) => call<{ next_runs: string[]; describe: string }>("POST", "/api/routines/preview", { cron, timezone }),
  thread: (id: string) => call<ThreadData>("GET", `/api/threads/${id}`),
  send: (threadId: string, text: string) => call("POST", `/api/threads/${threadId}/messages`, { text }),
  stop: (taskId: string) => call("POST", `/api/tasks/${taskId}/stop`),
};
