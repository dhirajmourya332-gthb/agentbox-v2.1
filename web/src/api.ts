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
  dm_thread_id: string;
  skills: string[];
};

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
export type Thread = { id: string; kind: "dm" | "handoff" | "group"; agent_id: string; peer_agent_id: string | null; last_at: string | null };
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
  state: () => call<{ agents: Agent[]; usage: Usage | null; groups: Group[] }>("GET", "/api/state"),
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
  updateAgent: (id: string, patch: Partial<Pick<Agent, "title" | "summary" | "model" | "max_turns">>) =>
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
  thread: (id: string) => call<ThreadData>("GET", `/api/threads/${id}`),
  send: (threadId: string, text: string) => call("POST", `/api/threads/${threadId}/messages`, { text }),
  stop: (taskId: string) => call("POST", `/api/tasks/${taskId}/stop`),
};
