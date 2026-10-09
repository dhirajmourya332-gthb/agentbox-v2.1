import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { api, connectEvents, HttpError, isRoutineRun } from "./api";
import type { Agent, Attention, Group, Message, Progress, RetiredAgent, Routine, RoutineRun, Step, Task, ThreadData, Usage, WorkRoom } from "./types";

/**
 * Live data while unlocked, kept in memory only (the provider unmounts on lock, dropping it).
 * Same model as the portal's store (web/src/store.tsx), trimmed to what the phone shows.
 */

type State = {
  connected: boolean;
  loaded: boolean;
  agents: Agent[];
  retired: RetiredAgent[];
  groups: Group[];
  usage: Usage | null;
  paused: boolean;
  work: { live: WorkRoom[]; done: WorkRoom[] };
  workLoaded: boolean;
  routines: Routine[];
  threads: Record<string, ThreadData>;
  /** Text streamed so far for running turns, by task id. */
  live: Record<string, string>;
  /** Contract A: what each working instance is doing, by task id. Null until the server answers. */
  progress: Record<string, Progress> | null;
  /** Contract B: "needs you" items, unseen first. Null until the server answers. */
  attention: Attention[] | null;
  /** Recent tasks from the board, newest first. */
  recent: Task[];
  /** Contract G: running routine runs, oldest first. Null until the server answers. */
  runs: RoutineRun[] | null;
  /** False when the server has no routine-run routes (404/410): the app hides those sections. */
  runsSupported: boolean | null;
  error: string | null;
};

export type Ev = { type: string; [k: string]: any };
type Action =
  | { type: "loaded"; agents: Agent[]; retired: RetiredAgent[]; groups: Group[]; usage: Usage | null; paused: boolean; routines: Routine[] }
  | { type: "work"; work: State["work"] }
  | { type: "progress"; list: Progress[] }
  | { type: "attention"; items: Attention[] }
  | { type: "recent"; tasks: Task[] }
  | { type: "runs"; runs: RoutineRun[] }
  | { type: "runsUnsupported" }
  | { type: "seen"; ids: string[] | "all" }
  | { type: "connected"; value: boolean }
  | { type: "thread"; id: string; data: ThreadData }
  | { type: "error"; error: string | null }
  | { type: "event"; e: Ev };

const upsert = <T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number) => {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
  return sort ? next.sort(sort) : next;
};

/** Unseen first, then newest first; at most 100 like the server. */
const sortAttention = (items: Attention[]) =>
  [...items]
    .sort((a, b) => (a.seen_at ? 1 : 0) - (b.seen_at ? 1 : 0) || b.created_at.localeCompare(a.created_at))
    .slice(0, 100);

const sortRuns = (runs: RoutineRun[]) => [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at));

/** Older servers answer the routine-run routes with 404 (or 410): treat that as "not supported". */
export const isMissingRoute = (e: unknown) => e instanceof HttpError && (e.status === 404 || e.status === 410);

const isProgress = (x: any): x is Progress =>
  x && typeof x === "object" && typeof x.task_id === "string" && typeof x.agent_id === "string" && typeof x.activity === "string";
const isAttention = (x: any): x is Attention =>
  x && typeof x === "object" && typeof x.id === "string" && typeof x.title === "string" && typeof x.created_at === "string";

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "loaded":
      return { ...s, loaded: true, agents: a.agents, retired: a.retired, groups: a.groups, usage: a.usage, paused: a.paused, routines: a.routines, error: null };
    case "work":
      return { ...s, work: a.work, workLoaded: true };
    case "progress":
      return { ...s, progress: Object.fromEntries(a.list.filter(isProgress).map((x) => [x.task_id, x])) };
    case "attention":
      return { ...s, attention: sortAttention(a.items.filter(isAttention)) };
    case "recent":
      return { ...s, recent: a.tasks };
    case "runs":
      return { ...s, runs: sortRuns(a.runs.filter((r) => r.status === "running")), runsSupported: true };
    case "runsUnsupported":
      return { ...s, runs: null, runsSupported: false };
    case "seen": {
      if (!s.attention) return s;
      const at = new Date().toISOString();
      return {
        ...s,
        attention: sortAttention(s.attention.map((x) => (!x.seen_at && (a.ids === "all" || a.ids.includes(x.id)) ? { ...x, seen_at: at } : x))),
      };
    }
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
        case "usage":
          return { ...s, usage: e.usage ?? null };
        case "group.updated":
          return e.group?.id ? { ...s, groups: upsert(s.groups, e.group as Group) } : s;
        case "group.deleted":
          return { ...s, groups: s.groups.filter((g) => g.id !== e.id) };
        case "routine.updated":
          return e.routine?.id ? { ...s, routines: upsert(s.routines, e.routine as Routine) } : s;
        case "routine.deleted":
          return { ...s, routines: s.routines.filter((r) => r.id !== e.id) };
        case "progress.updated":
          if (!isProgress(e.progress)) return s;
          return { ...s, progress: { ...(s.progress ?? {}), [e.progress.task_id]: e.progress } };
        case "progress.cleared": {
          if (typeof e.task_id !== "string" || !s.progress?.[e.task_id]) return s;
          const next = { ...s.progress };
          delete next[e.task_id];
          return { ...s, progress: next };
        }
        case "routine-run.updated": {
          if (!isRoutineRun(e.run) || s.runsSupported === false) return s;
          const run: RoutineRun = { ...e.run, members: Array.isArray(e.run.members) ? e.run.members : [] };
          const rest = (s.runs ?? []).filter((r) => r.id !== run.id);
          return { ...s, runsSupported: true, runs: sortRuns(run.status === "running" ? [...rest, run] : rest) };
        }
        case "attention.updated":
          if (!isAttention(e.item)) return s;
          return { ...s, attention: sortAttention(upsert(s.attention ?? [], e.item)) };
        case "turn.delta":
          if (typeof e.taskId !== "string" || typeof e.text !== "string") return s;
          return { ...s, live: { ...s.live, [e.taskId]: (s.live[e.taskId] ?? "") + e.text } };
        case "message.created":
        case "task.updated":
        case "step.updated": {
          const item = e.message ?? e.task ?? e.step;
          if (!item?.id) return s;
          let recent = s.recent;
          if (e.type === "task.updated" && recent.some((t) => t.id === item.id)) recent = recent.map((t) => (t.id === item.id ? { ...t, ...item } : t));
          const threadId: string | undefined =
            e.message?.thread_id ?? e.task?.thread_id ??
            Object.keys(s.threads).find((id) => s.threads[id].tasks.some((t) => t.id === e.step?.task_id));
          if (!threadId || !s.threads[threadId]) return recent === s.recent ? s : { ...s, recent };
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
          return { ...s, live, recent, threads: { ...s.threads, [threadId]: next } };
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
  colorOf: (id: string) => string | undefined;
  /** Mark "needs you" items seen (optimistic; the server confirms with attention.updated). */
  markSeen: (ids: string[] | "all") => void;
  /** Every live event, for screens that keep their own data (e.g. a routine run). Returns unsubscribe. */
  subscribe: (f: (e: Ev) => void) => () => void;
};

const Ctx = createContext<Store | null>(null);

const INITIAL: State = {
  connected: false, loaded: false, agents: [], retired: [], groups: [], usage: null, paused: false,
  work: { live: [], done: [] }, workLoaded: false, routines: [], threads: {}, live: {},
  progress: null, attention: null, recent: [], runs: null, runsSupported: null, error: null,
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const openThreads = useRef(new Set<string>());
  const workTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listeners = useRef(new Set<(e: Ev) => void>());
  const subscribe = useCallback((f: (e: Ev) => void) => {
    listeners.current.add(f);
    return () => { listeners.current.delete(f); };
  }, []);

  const refreshWork = useCallback(() => {
    clearTimeout(workTimer.current);
    workTimer.current = setTimeout(() => {
      api.work().then((w) => dispatch({ type: "work", work: w })).catch(() => {});
      api.tasks().then((t) => dispatch({ type: "recent", tasks: t })).catch(() => {});
    }, 400);
  }, []);

  /** Progress and attention are newer server features: failures leave them as they were. */
  const refreshLive = useCallback(async () => {
    await Promise.all([
      api.progress().then((list) => dispatch({ type: "progress", list: Array.isArray(list) ? list : [] })).catch(() => {}),
      api.attention().then((r) => dispatch({ type: "attention", items: Array.isArray(r?.items) ? r.items : [] })).catch(() => {}),
      api.tasks().then((t) => dispatch({ type: "recent", tasks: Array.isArray(t) ? t : [] })).catch(() => {}),
      api.routineRuns({ state: "active" }).then(
        (runs) => dispatch({ type: "runs", runs }),
        (e: unknown) => { if (isMissingRoute(e)) dispatch({ type: "runsUnsupported" }); },
      ),
    ]);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, r, w] = await Promise.all([api.state(), api.routines(), api.work(), refreshLive()]);
      dispatch({ type: "loaded", agents: s.agents, retired: s.retired ?? [], groups: s.groups ?? [], usage: s.usage ?? null, paused: s.paused, routines: r });
      dispatch({ type: "work", work: w });
    } catch (e) {
      dispatch({ type: "error", error: e instanceof Error ? e.message : "Couldn't load" });
    }
  }, [refreshLive]);

  const loadThread = useCallback(async (id: string) => {
    openThreads.current.add(id);
    dispatch({ type: "thread", id, data: await api.thread(id) });
  }, []);

  const markSeen = useCallback((ids: string[] | "all") => {
    if (ids !== "all" && !ids.length) return;
    dispatch({ type: "seen", ids });
    if (ids === "all") api.attentionSeenAll().catch(() => {});
    else ids.forEach((id) => { api.attentionSeen(id).catch(() => {}); });
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
        listeners.current.forEach((f) => { try { f(e); } catch { /* a screen's bug mustn't stop the feed */ } });
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
  const colorOf = useCallback(
    (id: string) => state.agents.find((a) => a.id === id)?.color ?? state.retired.find((a) => a.id === id)?.color,
    [state.agents, state.retired],
  );

  return <Ctx.Provider value={{ ...state, refresh, refreshWork, loadThread, nameOf, colorOf, markSeen, subscribe }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
