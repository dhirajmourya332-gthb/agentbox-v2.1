import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { api, connectEvents } from "./api";
import type { Agent, Message, RetiredAgent, Routine, Step, Task, ThreadData, WorkRoom } from "./types";

/**
 * Live data while unlocked, kept in memory only (the provider unmounts on lock, dropping it).
 * Same model as the portal's store (web/src/store.tsx), trimmed to what the phone shows.
 */

type State = {
  connected: boolean;
  loaded: boolean;
  agents: Agent[];
  retired: RetiredAgent[];
  paused: boolean;
  work: { live: WorkRoom[]; done: WorkRoom[] };
  workLoaded: boolean;
  routines: Routine[];
  threads: Record<string, ThreadData>;
  /** Text streamed so far for running turns, by task id. */
  live: Record<string, string>;
  error: string | null;
};

type Ev = { type: string; [k: string]: any };
type Action =
  | { type: "loaded"; agents: Agent[]; retired: RetiredAgent[]; paused: boolean; routines: Routine[] }
  | { type: "work"; work: State["work"] }
  | { type: "connected"; value: boolean }
  | { type: "thread"; id: string; data: ThreadData }
  | { type: "error"; error: string | null }
  | { type: "event"; e: Ev };

const upsert = <T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number) => {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
  return sort ? next.sort(sort) : next;
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "loaded":
      return { ...s, loaded: true, agents: a.agents, retired: a.retired, paused: a.paused, routines: a.routines, error: null };
    case "work":
      return { ...s, work: a.work, workLoaded: true };
    case "connected":
      return { ...s, connected: a.value };
    case "thread":
      return { ...s, threads: { ...s.threads, [a.id]: a.data } };
    case "error":
      return { ...s, error: a.error };
    case "event": {
      const e = a.e;
      switch (e.type) {
        case "agent.created":
        case "agent.updated": {
          if (!e.agent?.id || e.agent.retired_at) return s;
          const prev = s.agents.find((x) => x.id === e.agent.id);
          return { ...s, agents: upsert(s.agents, { status: "idle", ...prev, ...e.agent } as Agent) };
        }
        case "agent.status":
          return { ...s, agents: s.agents.map((x) => (x.id === e.agentId ? { ...x, status: e.status, taskId: e.taskId } : x)) };
        case "agent.retired":
        case "agent.deleted":
          return { ...s, agents: s.agents.filter((x) => x.id !== e.agentId) };
        case "paused":
          return { ...s, paused: !!e.paused };
        case "routine.updated":
          return e.routine?.id ? { ...s, routines: upsert(s.routines, e.routine as Routine) } : s;
        case "routine.deleted":
          return { ...s, routines: s.routines.filter((r) => r.id !== e.id) };
        case "turn.delta":
          if (typeof e.taskId !== "string" || typeof e.text !== "string") return s;
          return { ...s, live: { ...s.live, [e.taskId]: (s.live[e.taskId] ?? "") + e.text } };
        case "message.created":
        case "task.updated":
        case "step.updated": {
          const item = e.message ?? e.task ?? e.step;
          if (!item?.id) return s;
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
          if (e.type === "message.created" && item.author !== "user" && item.task_id && live[item.task_id]) {
            live = { ...live };
            delete live[item.task_id];
          }
          return { ...s, live, threads: { ...s.threads, [threadId]: next } };
        }
      }
      return s;
    }
  }
}

type Store = State & {
  refresh: () => Promise<void>;
  refreshWork: () => void;
  loadThread: (id: string) => Promise<void>;
  /** Display name for an agent id, including retired ones. */
  nameOf: (id: string) => string | undefined;
};

const Ctx = createContext<Store | null>(null);

const INITIAL: State = {
  connected: false, loaded: false, agents: [], retired: [], paused: false, work: { live: [], done: [] }, workLoaded: false,
  routines: [], threads: {}, live: {}, error: null,
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const openThreads = useRef(new Set<string>());
  const workTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshWork = useCallback(() => {
    clearTimeout(workTimer.current);
    workTimer.current = setTimeout(() => {
      api.work().then((w) => dispatch({ type: "work", work: w })).catch(() => {});
    }, 400);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, r, w] = await Promise.all([api.state(), api.routines(), api.work()]);
      dispatch({ type: "loaded", agents: s.agents, retired: s.retired ?? [], paused: s.paused, routines: r });
      dispatch({ type: "work", work: w });
    } catch (e) {
      dispatch({ type: "error", error: e instanceof Error ? e.message : "Couldn't load" });
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    openThreads.current.add(id);
    dispatch({ type: "thread", id, data: await api.thread(id) });
  }, []);

  useEffect(() => {
    refresh();
    const sock = connectEvents({
      onOpen: () => {
        dispatch({ type: "connected", value: true });
        // Catch up on anything missed while disconnected.
        refresh();
        openThreads.current.forEach((id) => { loadThread(id).catch(() => {}); });
      },
      onClose: () => dispatch({ type: "connected", value: false }),
      onEvent: (e) => {
        dispatch({ type: "event", e });
        if (["agent.created", "agent.retired", "agent.updated", "agent.status", "task.updated", "agent.deleted"].includes(e.type)) refreshWork();
      },
    });
    return () => {
      sock.close();
      clearTimeout(workTimer.current);
    };
  }, [refresh, loadThread, refreshWork]);

  const nameOf = useCallback(
    (id: string) => state.agents.find((a) => a.id === id)?.name ?? state.retired.find((a) => a.id === id)?.name,
    [state.agents, state.retired],
  );

  return <Ctx.Provider value={{ ...state, refresh, refreshWork, loadThread, nameOf }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
