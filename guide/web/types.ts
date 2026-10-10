// The shape of the guide server's snapshot (guide/src/app.ts › snapshot()).
export type StepState = "pending" | "running" | "human" | "done" | "failed" | "disabled";

export type StepView = {
  key: string; module: string; id: string; title: string; human: boolean; state: StepState;
  check?: string; instructions?: string; copy?: string; error?: string; checkedAt?: number;
};

export type ModuleView = {
  id: string; title: string; description: string; optional: boolean; depends: string[];
  enabled: boolean; implied: boolean; state: StepState; steps: StepView[];
};

export type LogEntry = { id: number; at: number; kind: "text" | "tool" | "output" | "info" | "error" | "done"; text: string };

export type AgentStatus = "idle" | "running" | "waiting" | "paused";

export type Snapshot = {
  type: "state";
  host: { kind: string; name: string; access: string; user: string };
  ports: { portal: number; guide: number };
  portalUrl: string | null;
  usage: { status?: string; resetsAt?: number; utilization?: number; rateLimitType?: string; costUsd?: number };
  problems: string[];
  profile: { done: boolean; checked: boolean; required: string[]; modules: Record<string, boolean> };
  claudeReady: boolean;
  agent: { status: AgentStatus; hasSession: boolean };
  roadmap: {
    modules: ModuleView[];
    profile: { order: string[]; chosen: string[]; implied: string[]; missing: string[]; cycles: string[] };
    nextHuman: StepView | null;
    allDone: boolean;
    counts: { total: number; done: number; human: number; failed: number };
  };
  selftest: { ok?: boolean; output?: string; at?: number; running: boolean };
  finished: boolean;
  settled: boolean;
};
