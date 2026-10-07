import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { api, type Agent, type Message, type Skill, type SkillDraft, type Step, type Task, type ThreadData, type Usage } from "./api.ts";

type State = {
  connected: boolean;
  loaded: boolean;
  agents: Agent[];
  usage: Usage | null;
  skills: Skill[];
  drafts: SkillDraft[];
  threads: Record<string, ThreadData>;
  /** Text streamed so far for running turns, by task id. */
  live: Record<string, string>;
};

type Action =
  | { type: "loaded"; agents: Agent[]; usage: Usage | null; skills: Skill[]; drafts: SkillDraft[] }
  | { type: "connected"; value: boolean }
  | { type: "thread"; id: string; data: ThreadData }
  | { type: "event"; e: any };

const upsert = <T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number) => {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
  return sort ? next.sort(sort) : next;
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "loaded":
      return { ...s, loaded: true, agents: a.agents, usage: a.usage, skills: a.skills, drafts: a.drafts };
    case "connected":
      return { ...s, connected: a.value };
    case "thread":
      return { ...s, threads: { ...s.threads, [a.id]: a.data } };
    case "event": {
      const e = a.e;
      switch (e.type) {
        case "agent.created":
        case "agent.updated": {
          const prev = s.agents.find((x) => x.id === e.agent.id);
          const agent = { status: "idle", ...prev, ...e.agent } as Agent;
          return { ...s, agents: upsert(s.agents, agent) };
        }
        case "agent.deleted":
          return { ...s, agents: s.agents.filter((x) => x.id !== e.agentId) };
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
    connected: false, loaded: false, agents: [], usage: null, skills: [], drafts: [], threads: {}, live: {},
  });
  const openThreads = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const [s, k] = await Promise.all([api.state(), api.skills()]);
    dispatch({ type: "loaded", agents: s.agents, usage: s.usage, skills: k.skills, drafts: k.drafts });
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
