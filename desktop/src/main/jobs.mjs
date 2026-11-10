import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/**
 * Long things the app does for the owner (create a VM, install, update): a job with steps and a live
 * log, so nothing ever looks frozen. The window shows them; they keep running if it's closed.
 */

export const jobEvents = new EventEmitter();
const jobs = new Map();
const MAX_LINES = 4000;

export function createJob(kind, title, meta = {}) {
  const job = {
    id: randomUUID(), kind, title, meta, state: "running", step: null, steps: [], lines: [], error: null, result: null,
    started_at: new Date().toISOString(), finished_at: null, controller: new AbortController(),
  };
  jobs.set(job.id, job);
  const emit = () => jobEvents.emit("job", view(job));
  const api = {
    id: job.id,
    signal: job.controller.signal,
    log(line) {
      job.lines.push({ t: Date.now(), text: String(line) });
      if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
      jobEvents.emit("line", { id: job.id, text: String(line) });
    },
    step(title) {
      if (job.step) { const s = job.steps.find((x) => x.title === job.step); if (s && s.state === "running") s.state = "done"; }
      job.step = title;
      job.steps.push({ title, state: "running", at: new Date().toISOString() });
      api.log(`▸ ${title}`);
      emit();
    },
    /** A step the owner has to do (a login, a choice): shown as "your turn" until the next step. */
    wait(title) {
      job.steps.push({ title, state: "waiting", at: new Date().toISOString() });
      emit();
    },
    done(result = null) {
      for (const s of job.steps) if (s.state === "running" || s.state === "waiting") s.state = "done";
      job.state = "done"; job.result = result; job.finished_at = new Date().toISOString();
      emit();
    },
    fail(err) {
      const s = job.steps.find((x) => x.state === "running");
      if (s) s.state = "failed";
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = String(err?.message ?? err);
      job.finished_at = new Date().toISOString();
      api.log(`✖ ${job.error}`);
      emit();
    },
    update(meta) { Object.assign(job.meta, meta); emit(); },
  };
  emit();
  return api;
}

export function view(job, withLines = false) {
  return {
    id: job.id, kind: job.kind, title: job.title, meta: job.meta, state: job.state, steps: job.steps, error: job.error, result: job.result,
    started_at: job.started_at, finished_at: job.finished_at, ...(withLines ? { lines: job.lines.map((l) => l.text) } : {}),
  };
}

export const listJobs = () => [...jobs.values()].map((j) => view(j)).reverse();
export const getJob = (id) => (jobs.has(id) ? view(jobs.get(id), true) : null);
export function cancelJob(id) { jobs.get(id)?.controller.abort(); }

/** Run `fn(job)` as a job: its errors fail the job instead of throwing. */
export function runJob(kind, title, meta, fn) {
  const job = createJob(kind, title, meta);
  Promise.resolve().then(() => fn(job)).then((r) => job.done(r ?? null), (e) => job.fail(e));
  return job.id;
}
