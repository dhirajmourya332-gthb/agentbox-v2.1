import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.ts";

/**
 * Temporary sudo for the setup agent (docs/V2-ARCHITECTURE.md §10.4): a sudoers drop-in exists only
 * while at least one setup turn runs. It's created when the turn starts and removed when the last one
 * ends, removed at server start (a crash can't leave it behind), and swept every minute.
 *
 * How it's written:
 * - the drop-in directory is writable by the server (AGENTBOX_SUDOERS_DIR in tests): directly, with a
 *   temp file + rename, mode 0440;
 * - otherwise (production, /etc/sudoers.d is root's): `sudo -n <helper> grant|revoke`, the root-owned
 *   helper server/setup-agent/agentbox-setup-sudo, which grants only while the portal confirms a setup
 *   turn is running (GET /api/setup/sudo), validates with visudo, and always allows revoke.
 *
 * All agents run as one unix user, so while the grant exists other roles' turns could use it too;
 * runner.ts denies their `sudo` commands meanwhile (sudoGuard) unless agent_sudo is on anyway.
 */

export const sudoersDir = () => process.env.AGENTBOX_SUDOERS_DIR ?? "/etc/sudoers.d";
export const SUDOERS_NAME = "agentbox-setup";
export const sudoersFile = () => path.join(sudoersDir(), SUDOERS_NAME);
const helper = () => process.env.AGENTBOX_SUDO_HELPER ?? "/usr/local/sbin/agentbox-setup-sudo";

const holders = new Set<string>();
/** A setup turn holds the grant right now. */
export const sudoActive = () => holders.size > 0;
export const sudoHolders = () => [...holders];

const direct = () => {
  try { fs.accessSync(sudoersDir(), fs.constants.W_OK); return true; } catch { return false; }
};

function write() {
  const line = `# agentbox: temporary sudo for the setup agent; removed when its turn ends\n${config.user} ALL=(ALL) NOPASSWD:ALL\n`;
  if (direct()) {
    const tmp = path.join(sudoersDir(), `.${SUDOERS_NAME}.tmp`);
    fs.writeFileSync(tmp, line, { mode: 0o440 });
    fs.chmodSync(tmp, 0o440);
    fs.renameSync(tmp, sudoersFile());
    return;
  }
  execFileSync("sudo", ["-n", helper(), "grant"], { timeout: 15_000, stdio: "pipe" });
}

function remove() {
  if (direct()) {
    fs.rmSync(sudoersFile(), { force: true });
    fs.rmSync(path.join(sudoersDir(), `.${SUDOERS_NAME}.tmp`), { force: true });
    return;
  }
  if (!fs.existsSync(sudoersFile())) return;
  execFileSync("sudo", ["-n", helper(), "revoke"], { timeout: 15_000, stdio: "pipe" });
}

/** At the start of a setup turn. Returns whether sudo is available for it (and why not). */
export function grantSetupSudo(taskId: string): { ok: boolean; error?: string } {
  holders.add(taskId);
  try {
    if (!fs.existsSync(sudoersFile())) write();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr ?? e?.message ?? e).trim().slice(0, 300) };
  }
}

/** At the end of a setup turn (always, in a finally). The last one out removes the drop-in. */
export function releaseSetupSudo(taskId: string) {
  holders.delete(taskId);
  if (holders.size) return;
  try { remove(); } catch (e: any) { console.error("sudo: could not remove the setup grant:", e?.message ?? e); }
}

/** Server start: nothing can be running yet, so no grant may exist. */
export function cleanupSetupSudo() {
  holders.clear();
  try { remove(); } catch (e: any) { console.error("sudo: could not remove a leftover setup grant:", e?.message ?? e); }
}

/** Periodic guard: a grant with no running setup turn is removed. */
export function sweepSetupSudo() {
  if (holders.size || !fs.existsSync(sudoersFile())) return;
  try { remove(); } catch { /* next sweep */ }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startSudoSweeper(everyMs = 60_000) {
  cleanupSetupSudo();
  clearInterval(timer);
  timer = setInterval(sweepSetupSudo, everyMs);
  timer.unref();
}
