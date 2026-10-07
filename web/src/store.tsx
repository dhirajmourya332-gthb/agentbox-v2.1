import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { api, type Agent, type DisplayHolder, type Group, type Routine, type Message, type Skill, type SkillDraft, type Step, type Task, type ThreadData, type Usage } from "./api.ts";

type State = {
  connected: boolean;
  loaded: boolean;
  agents: Agent[];
  usage: Usage | null;
  skills: Skill[];
  drafts: SkillDraft[];
  groups: Group[];
  routines: Routine[];
  paused: boolean;
  display: DisplayHolder;
  /** Bumped on any event that could change the activity feed. */
  activityVersion: number;
  threads: Record<string, ThreadData>;
  /** Every task we've seen, for the board. */
  board: Record<string, Task>;
  /** Bumped when a thread is created, so views listing threads refetch. */
  threadsVersion: number;
  /** Text streamed so far for running turns, by task id. */
  live: Record<string, string>;
};

type Action =
  | { type: "loaded"; agents: Agent[]; usage: Usage | null; skills: Skill[]; drafts: SkillDraft[]; groups: Group[]; paused: boolean; display: DisplayHolder }
  | { type: "connected"; value: boolean }
  | { type: "thread"; id: string; data: ThreadData }
  | { type: "board"; tasks: Task[] }
  | { type: "routines"; routines: Routine[] }
  | { type: "event"; e: any };

const upsert = <T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number) => {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
  return sort ? next.sort(sort) : next;
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "loaded":
      return { ...s, loaded: true, agents: a.agents, usage: a.usage, skills: a.skills, drafts: a.drafts, groups: a.groups, paused: a.paused, display: a.display };
    case "connected":
      return { ...s, connected: a.value };
    case "thread":
      return { ...s, threads: { ...s.threads, [a.id]: a.data } };
    case "routines":
      return { ...s, routines: a.routines };
    case "board":
      return { ...s, board: Object.fromEntries(a.tasks.map((t) => [t.id, t])) };
    case "event": {
      const e = a.e;
      if (["task.updated", "draft.updated", "routine.updated"].includes(e.type)) s = { ...s, activityVersion: s.activityVersion + 1 };
      switch (e.type) {
        case "agent.created":
        case "agent.updated": {
          const prev = s.agents.find((x) => x.id === e.agent.id);
          const agent = { status: "idle", ...prev, ...e.agent } as Agent;
          return { ...s, agents: upsert(s.agents, agent) };
        }
        case "agent.skills":
          return { ...s, agents: s.agents.map((x) => (x.id === e.agentId ? { ...x, skills: e.skills } : x)) };
        case "skill.updated":
          return {
            ...s,
            skills: [...s.skills.filter((k) => k.name !== e.skill.name), e.skill as Skill]
              .sort((x, y) => x.name.localeCompare(y.name)),
          };
        case "skill.deleted":
          return { ...s, skills: s.skills.filter((k) => k.name !== e.name) };
        case "draft.updated":
          return {
            ...s,
            drafts: e.draft.status === "pending"
              ? upsert(s.drafts, e.draft)
              : s.drafts.filter((d) => d.id !== e.draft.id),
          };
        case "paused":
          return { ...s, paused: e.paused };
        case "display.updated":
          return { ...s, display: e.display };
        case "routine.updated":
          return { ...s, routines: upsert(s.routines, e.routine) };
        case "routine.deleted":
          return { ...s, routines: s.routines.filter((r) => r.id !== e.id) };
        case "group.updated":
          return { ...s, groups: upsert(s.groups, e.group) };
        case "group.deleted":
          return { ...s, groups: s.groups.filter((g) => g.id !== e.id) };
        case "agent.deleted":
          return {
            ...s,
            agents: s.agents.filter((x) => x.id !== e.agentId),
            groups: s.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== e.agentId) })),
          };
        case "thread.created":
          return { ...s, threadsVersion: s.threadsVersion + 1 };
        case "agent.status":
          return { ...s, agents: s.agents.map((x) => (x.id === e.agentId ? { ...x, status: e.status, taskId: e.taskId } : x)) };
        case "usage":
          return { ...s, usage: e.usage };
        case "turn.delta":
          return { ...s, live: { ...s.live, [e.taskId]: (s.live[e.taskId] ?? "") + e.text } };
        case "message.created":
        case "task.updated":
        case "step.updated": {
          const item = e.message ?? e.task ?? e.step;
          if (e.type === "task.updated") s = { ...s, board: { ...s.board, [e.task.id]: { ...s.board[e.task.id], ...e.task } } };
          const threadId: string | undefined =
            e.message?.thread_id ?? e.task?.thread_id ??
            Object.keys(s.threads).find((id) => s.threads[id].tasks.some((t) => t.id === e.step?.task_id));
          if (!threadId || !s.threads[threadId]) return s;
          const t = s.threads[threadId];
          const next: ThreadData =
            e.type === "message.created" ? { ...t, messages: upsert<Message>(t.messages, item) }
            : e.type === "task.updated" ? { ...t, tasks: upsert<Task>(t.tasks, item) }
            : { ...t, steps: upsert<Step>(t.steps, item, (x, y) => x.seq - y.seq) };
          let live = s.live;
          // Once the agent's message lands, the streamed copy is no longer needed.
          if (e.type === "message.created" && e.message.author !== "user" && e.message.task_id && live[e.message.task_id]) {
            live = { ...live };
            delete live[e.message.task_id];
          }
          return { ...s, live, threads: { ...s.threads, [threadId]: next } };
        }
      }
      return s;
    }
  }
}

type Store = State & {
  loadThread: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    connected: false, loaded: false, agents: [], usage: null, skills: [], drafts: [], groups: [], routines: [], paused: false, display: null, activityVersion: 0, threads: {}, live: {}, board: {}, threadsVersion: 0,
  });
  const openThreads = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const [s, k, t, r] = await Promise.all([api.state(), api.skills(), api.tasks(), api.routines()]);
    dispatch({ type: "routines", routines: r });
    dispatch({ type: "loaded", agents: s.agents, usage: s.usage, skills: k.skills, drafts: k.drafts, groups: s.groups, paused: s.paused, display: s.display });
    dispatch({ type: "board", tasks: t });
  }, []);

  const loadThread = useCallback(async (id: string) => {
    openThreads.current.add(id);
    dispatch({ type: "thread", id, data: await api.thread(id) });
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
      ws.onopen = () => {
        dispatch({ type: "connected", value: true });
        // Catch up on anything missed while disconnected.
        refresh().catch(() => {});
        openThreads.current.forEach((id) => loadThread(id).catch(() => {}));
      };
      ws.onmessage = (m) => dispatch({ type: "event", e: JSON.parse(m.data) });
      ws.onclose = () => {
        dispatch({ type: "connected", value: false });
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [refresh, loadThread]);

  return <Ctx.Provider value={{ ...state, loadThread, refresh }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
