/**
 * Live progress formatting for long integration runs (a gcloud install can take 10+ minutes on a
 * small VM). The same rules as the setup guide's (guide/src/progress.ts): elapsed time, and a calm
 * "still working" line once the output has been quiet for a while.
 */

/** No new output for this long: show the "Still working" line. */
export const HEARTBEAT_MS = 20_000;
/** setup/lib/apt-wait.sh prints its "waiting for apt" notices with this mark. */
export const WAIT_MARK = "⏳";

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
  return `Still working: no new output for ${fmtDuration(quiet)}. Some installs take several minutes on a small VM.`;
}

/** Is this line a wait_for_apt notice? Returns its text without the mark. */
export function waitNotice(line: string): string | null {
  const t = line.trim();
  return t.startsWith(WAIT_MARK) ? t.slice(WAIT_MARK.length).trim() : null;
}

/** "Connecting… 2 min 14 s" */
export function runningLabel(action: string, startedAt: number, now: number) {
  const verb = action === "verify" ? "Verifying" : action === "disconnect" ? "Disconnecting" : "Connecting";
  return `${verb}… ${fmtDuration(now - startedAt)}`;
}
