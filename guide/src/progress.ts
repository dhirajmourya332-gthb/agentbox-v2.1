/**
 * Live progress of the steps being worked on (docs/GUIDE.md › Live progress). Pure, no Node APIs:
 * the server keeps the jobs, the page imports the formatting (elapsed time, heartbeat line).
 *
 * A job is one running install / verify of a module (by the setup agent or a Retry). It keeps the
 * last lines of output, when it started, when output last arrived, and, if the newest line is a
 * `wait_for_apt` notice (setup/lib/apt-wait.sh: "⏳ …"), that notice: the page shows it as a calm
 * "Waiting for Ubuntu updates" badge instead of an error.
 */

export const TAIL_LINES = 10;
/** No new output for this long: the page shows the "Still working" line. */
export const HEARTBEAT_MS = 20_000;
export const WAIT_MARK = "⏳";

export type Job = {
  module: string;
  what: string; // install | verify | enable
  by: "agent" | "retry";
  startedAt: number;
  lastOutputAt: number;
  lines: string[];
  partial: string;
  /** The latest wait_for_apt notice, while it is the newest output. */
  waiting: { text: string; at: number } | null;
};

export type JobView = {
  module: string; what: string; by: Job["by"];
  startedAt: number; lastOutputAt: number;
  tail: string[];
  waiting: { text: string; at: number } | null;
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function newJob(module: string, what: string, by: Job["by"], now: number): Job {
  return { module, what, by, startedAt: now, lastOutputAt: now, lines: [], partial: "", waiting: null };
}

/** Is this line a wait_for_apt notice? Returns its text without the mark. */
export function waitNotice(line: string): string | null {
  const t = line.trim();
  return t.startsWith(WAIT_MARK) ? t.slice(WAIT_MARK.length).trim() : null;
}

/** Feed a chunk of output (any split; \r progress redraws count as line ends). */
export function addOutput(job: Job, chunk: string, now: number) {
  if (!chunk) return;
  job.lastOutputAt = now;
  const text = (job.partial + chunk.replace(ANSI, "")).replace(/\r\n/g, "\n");
  const parts = text.split(/[\n\r]/);
  job.partial = parts.pop() ?? "";
  if (job.partial.length > 2000) job.partial = job.partial.slice(-2000);
  for (const raw of parts) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const w = waitNotice(line);
    job.waiting = w ? { text: w, at: now } : null;
    job.lines.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
  }
  if (job.lines.length > TAIL_LINES * 4) job.lines.splice(0, job.lines.length - TAIL_LINES * 4);
}

export function jobView(job: Job): JobView {
  const tail = job.lines.slice(-TAIL_LINES);
  if (job.partial.trim() && tail.length < TAIL_LINES + 1) tail.push(job.partial.trim());
  return {
    module: job.module, what: job.what, by: job.by,
    startedAt: job.startedAt, lastOutputAt: job.lastOutputAt,
    tail: tail.slice(-TAIL_LINES), waiting: job.waiting,
  };
}

/** "45 s", "2 min 14 s", "1 h 3 min". */
export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The calm line under a running step that has been quiet for a while (null while output flows). */
export function heartbeat(lastOutputAt: number, now: number): string | null {
  const quiet = now - lastOutputAt;
  if (quiet < HEARTBEAT_MS) return null;
  return `Still working: no new output for ${fmtDuration(quiet)}. Some steps take several minutes on a small VM.`;
}

/** "Installing… 2 min 14 s" */
export function runningLabel(what: string, startedAt: number, now: number) {
  const verb = what === "verify" ? "Verifying" : what === "selftest" ? "Running the self-test" : "Installing";
  return `${verb}… ${fmtDuration(now - startedAt)}`;
}
