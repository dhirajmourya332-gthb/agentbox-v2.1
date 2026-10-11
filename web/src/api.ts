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
  /** Built-in roles (e.g. "setup"): not deletable or renamable; their CLAUDE.md belongs to agentbox. */
  builtin?: string | null;
  owner_notes?: string | null;
  /** Roles: ids of the integrations mapped to them. */
  integrations?: string[];
};
export type StepState = "pending" | "running" | "human" | "done" | "failed" | "skipped";
export type IntegrationState = "available" | "connecting" | "connected" | "error" | "disconnected" | "unavailable";
export type SettingValue = string | number | boolean | string[];
export type IntegrationGate =
  | { kind: "setting"; key: string; title: string; command: string }
  | { kind: "step"; id: string; title: string; instructions: string | null; copy: string | null };
/** The last (or running) connect / verify / disconnect, for the steps card's live progress. */
export type IntegrationJob = {
  action: "connect" | "verify" | "disconnect"; running: boolean; started_at: string; ended_at: string | null;
  last_output_at: string; ok: boolean | null; code: number | null; timed_out: boolean;
};
/** server/src/integrations.ts › Integration (adapted from `agentbox integration status --json`). */
export type Integration = {
  id: string; title: string; description: string; category: string; state: IntegrationState;
  /** False: "coming soon" (state "unavailable"). */
  available: boolean; enabled: boolean; account: string | null; depends: string[];
  settings: {
    key: string; prompt: string; type: "string" | "boolean" | "list" | "enum" | "number"; required: boolean;
    default: SettingValue | null; options: string[] | null; pattern: string | null; example: string | null;
    value: SettingValue | null; missing: boolean; error: string | null;
  }[];
  settings_saved: boolean; missing: string[];
  steps: {
    id: string; title: string; human: boolean; instructions: string | null; copy: string | null; state: StepState;
    check: { ok: boolean; code: number | null; output: string | null; timed_out: boolean } | null; last_error: string | null;
  }[];
  gates: IntegrationGate[];
  revoke: string | null;
  default_roles: string[]; skills: string[];
  last: { action: string; ok: boolean | null; error: string | null; at: string | null } | null;
  /** Mapped role ids. */
  roles: string[];
  // GET /api/integrations/:id only:
  output?: { line: string; at: string }[];
  job?: IntegrationJob | null;
  /** The server's clock when it answered (elapsed times don't depend on the browser's). */
  now?: string;
};
export type Approval = {
  id: string; kind: "mapping" | "team_rule"; status: "pending" | "approved" | "rejected" | "failed";
  proposed_by: string; proposed_by_name?: string | null; task_id: string | null; thread_id: string | null;
  title: string; error: string | null; created_at: string; decided_at: string | null;
  payload: {
    integration_id?: string; integration_title?: string; roles?: string[]; before?: string[]; added?: string[]; removed?: string[];
    file?: string; relative?: string; reason?: string; created?: boolean; diff?: { op: " " | "-" | "+"; text: string }[];
  };
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
/** A row of a routine's own run log (GET /api/routines/:id). */
export type RoutineRunRow = {
  id: string; at: string; trigger: "schedule" | "manual"; outcome: "started" | "skipped"; reason: string | null; task_id: string | null;
  task_status: string | null; task_error?: string | null;
  status?: RunStatus | null; finished_at?: string | null; summary?: string | null;
};
export type RunStatus = "running" | "done" | "failed" | "stopped" | "skipped";
/** A routine run, active or finished (server routineRuns.ts, CONTRACTS-v2 § G). */
export type RoutineRun = {
  id: string; routine_id: string; routine_name: string; role_id: string; instance_id: string | null;
  trigger: "schedule" | "manual"; started_at: string; finished_at: string | null;
  status: RunStatus; reason: string | null;
  summary: string | null; duration_s: number | null; tasks: number;
  members: { id: string; name: string; label: string | null; status: string }[];
};
export type RunDetail = {
  run: RoutineRun; members: InstanceSummary[]; threads: { id: string; agent_id: string; kind: string }[];
  messages: Message[]; tasks: Task[]; steps: Step[];
};
export type Routine = {
  id: string; agent_id: string; thread_id: string; name: string; cron: string; timezone: string; prompt: string;
  enabled: boolean; created_by: string; created_at: string; next_runs: string[]; describe: string; last_run: RoutineRunRow | null;
  instance_id: string | null; context_mode: "continue" | "fresh"; workspace: string | null;
  group: { id: string; name: string; label: string | null; role_id: string; context_tokens: number | null }[];
  compaction: { runs_since: number; last_at: string | null; context_tokens: number; due: string[] };
  rules: RoutineRules; rules_summary: string[];
};
export type RoutineRules = {
  everyone: string;
  roles: Record<string, string>;
  perms: {
    merge_main: "never" | "safe" | "allowed" | null;
    deploy: "none" | "staging" | "production" | null;
    issues: boolean | null;
    teams: boolean | null;
    max_helpers: number | null;
  };
};
export type DisplayHolder = { holder: string; reason: string; since: string; last_used: string; task_id: string | null } | null;
export type ActivityItem = {
  id: string; ts: string; kind: string; actor: string; agent_id: string | null; title: string; detail?: string; task_id?: string | null; link?: string;
};
export type GraphEdge = { from: string; to: string; kind: string; n: number; last: string };
export type RoutineInput = { agent_id: string; name: string; cron: string; timezone: string; prompt: string; enabled: boolean; context_mode?: "continue" | "fresh"; rules?: RoutineRules };
export type ThreadData = { messages: Message[]; tasks: Task[]; steps: Step[] };
/** Live progress of a running task (server progress.ts, CONTRACTS-v2 § A). */
export type Progress = {
  agent_id: string; task_id: string; root_id: string | null; group_id: string | null;
  activity: string;
  step: { name: string; summary: string; started_at: string } | null;
  started_at: string; last_step_at: string;
  state: "working" | "stalled"; stalled_for_s: number | null;
  summary: string | null;
  /** Routine work only: the run this task belongs to. */
  run_id?: string | null;
};
/** A "needs you" item (server attention.ts, CONTRACTS-v2 § B). room_id: task-room root or group id. */
export type Attention = {
  id: string; kind: "reply" | "failed" | "stalled" | "question";
  agent_id: string; task_id: string | null; room_id: string | null;
  title: string; created_at: string; seen_at: string | null;
};

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

export type Device = {
  id: string; name: string; fingerprint: string; app_version: string | null; tailnet_login: string | null;
  status: "pending" | "active"; created_at: string; approved_at: string | null; last_seen_at: string | null; expires_at: string | null;
  /** Notifications on (the phone registered a push token). The token itself never reaches the portal. */
  push: boolean;
};
export type Pairing = { id: string; code: string; expires_at: string; url: string; qr_payload: string };
export type GatewayStatus = {
  tailscale: {
    installed: boolean; backend_state: string | null; dns_name: string | null; url: string | null;
    serve_target: string | null; funnel: boolean | null; funnel_capable: boolean | null; error?: string;
  };
  guard: { present: boolean | null; detail: string };
  manual_url: string | null;
  url: string | null;
  port: number;
};

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
  newTask: (roleId: string, text: string, title?: string, images?: string[]) => call<Agent>("POST", "/api/work", { role_id: roleId, text, title, images }),
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
  screenCredential: () => call<{ password: string | null }>("GET", "/api/screen/credential"),
  authMe: () => call<{ mode: string; host: string | null; identity: unknown }>("GET", "/api/auth/me"),
  logout: () => call<{ ok: true; logout_url: string | null }>("POST", "/api/auth/logout"),
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
  routine: (id: string) => call<{ routine: Routine; runs: RoutineRunRow[] }>("GET", `/api/routines/${id}`),
  routineRuns: (q: { state?: "active" | "archive"; routine_id?: string; before?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return call<{ runs: RoutineRun[] }>("GET", `/api/routine-runs?${p}`);
  },
  routineRun: (id: string) => call<RunDetail>("GET", `/api/routine-runs/${id}`),
  createRoutine: (b: RoutineInput) => call<Routine>("POST", "/api/routines", b),
  updateRoutine: (id: string, b: RoutineInput) => call<Routine>("PUT", `/api/routines/${id}`, b),
  deleteRoutine: (id: string) => call("DELETE", `/api/routines/${id}`),
  compactRoutine: (id: string) => call("POST", `/api/routines/${id}/compact`),
  freshRoutine: (id: string) => call("POST", `/api/routines/${id}/fresh`),
  runRoutine: (id: string) => call<{ started: boolean; routine: Routine }>("POST", `/api/routines/${id}/run`),
  previewCron: (cron: string, timezone: string) => call<{ next_runs: string[]; describe: string }>("POST", "/api/routines/preview", { cron, timezone }),
  thread: (id: string) => call<ThreadData>("GET", `/api/threads/${id}`),
  send: (threadId: string, text: string, images?: string[]) => call("POST", `/api/threads/${threadId}/messages`, { text, images }),
  /** Voice input (CONTRACTS-v2 C). Errors carry the HTTP status (`status`) so the UI can explain them. */
  transcribe: async (body: { audio: string; mime: string; purpose: "task" | "message"; agent_id?: string }, signal?: AbortSignal) => {
    const res = await fetch("/api/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data as any).error ?? `${res.status} ${res.statusText}`), { status: res.status });
    return data as { text: string; raw: string; duration_s: number; cleaned: boolean };
  },
  /** Voice v2 (CONTRACTS-v2 C): tidy up text the browser recognised. Errors carry `status`. */
  cleanVoice: async (body: { text: string; purpose: "task" | "message"; agent_id?: string; lang?: string }, signal?: AbortSignal) => {
    const res = await fetch("/api/voice/clean", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data as any).error ?? `${res.status} ${res.statusText}`), { status: res.status });
    return data as { text: string; raw: string; cleaned: boolean };
  },
  upload: (name: string, type: string, data: string) => call<{ path: string; name: string; size: number }>("POST", "/api/uploads", { name, type, data }),
  stop: (taskId: string) => call("POST", `/api/tasks/${taskId}/stop`),
  progress: () => call<Progress[]>("GET", "/api/progress"),
  attention: () => call<{ items: Attention[] }>("GET", "/api/attention"),
  attentionSeen: (id: string) => call<Attention>("POST", `/api/attention/${id}/seen`),
  attentionSeenAll: () => call<{ seen: number }>("POST", "/api/attention/seen-all"),
  attentionSeenRoom: (roomId: string) => call<{ seen: number }>("POST", `/api/attention/seen-room/${roomId}`),
  // Device admin always sends a JSON body: the server requires it (it forces a CORS preflight).
  devices: () => call<{ pending: Device[]; active: Device[] }>("GET", "/api/devices"),
  newPairing: () => call<Pairing>("POST", "/api/devices/pairings", {}),
  cancelPairing: () => call("DELETE", "/api/devices/pairings", {}),
  approveDevice: (id: string) => call("POST", `/api/devices/${id}/approve`, {}),
  denyDevice: (id: string) => call("POST", `/api/devices/${id}/deny`, {}),
  revokeDevice: (id: string) => call("POST", `/api/devices/${id}/revoke`, {}),
  revokeAllDevices: () => call<{ revoked: number }>("POST", "/api/devices/revoke-all", {}),
  pushSettings: () => call<{ details: boolean }>("GET", "/api/devices/push"),
  setPushDetails: (details: boolean) => call<{ details: boolean }>("PUT", "/api/devices/push", { details }),
  testPush: (id: string) => call<{ ok: true }>("POST", `/api/devices/${id}/test-push`, {}),
  gateway: (fresh = false) => call<GatewayStatus>("GET", `/api/devices/gateway${fresh ? "?fresh=1" : ""}`),
  setGatewayUrl: (url: string) => call<GatewayStatus>("PUT", "/api/devices/gateway", { url }),
  // Integrations and the setup agent (docs/V2-ARCHITECTURE.md §10).
  integrations: () => call<{ integrations: Integration[]; setup_role_id: string | null; error: string | null }>("GET", "/api/integrations"),
  integration: (id: string) => call<Integration>("GET", `/api/integrations/${id}`),
  setIntegrationRoles: (id: string, roles: string[]) => call<{ roles: string[] }>("PUT", `/api/integrations/${id}/roles`, { roles }),
  integrationTask: (id: string, action: "connect" | "reconnect" | "disconnect") =>
    call<{ instance_id: string; created: boolean }>("POST", `/api/integrations/${id}/task`, { action }),
  roleIntegrations: (roleId: string) => call<{ integrations: string[] }>("GET", `/api/agents/${roleId}/integrations`),
  setRoleIntegrations: (roleId: string, integrations: string[]) =>
    call<{ integrations: string[] }>("PUT", `/api/agents/${roleId}/integrations`, { integrations }),
  saveNotes: (roleId: string, text: string) => call<{ owner_notes: string }>("PUT", `/api/agents/${roleId}/notes`, { text }),
  approval: (id: string) => call<Approval>("GET", `/api/approvals/${id}`),
  approve: (id: string) => call<Approval>("POST", `/api/approvals/${id}/approve`),
  reject: (id: string) => call<Approval>("POST", `/api/approvals/${id}/reject`),
};
