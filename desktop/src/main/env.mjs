import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";

/**
 * The computer the app runs on: finding programs (gcloud, python, ssh, tailscale) the same way on
 * macOS, Windows and Linux, and running them. Nothing here is platform-specific beyond the lookups.
 */

export const isWin = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Apps opened from the Dock / Start menu don't get the login shell's PATH: take it from the shell, plus the usual places. */
export function fixPath() {
  const extra = isWin
    ? [path.join(process.env.LOCALAPPDATA ?? "", "Google", "Cloud SDK", "google-cloud-sdk", "bin"),
       path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Cloud SDK", "google-cloud-sdk", "bin"),
       path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Cloud SDK", "google-cloud-sdk", "bin"),
       path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale")]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/snap/bin",
       path.join(os.homedir(), "google-cloud-sdk", "bin"), path.join(os.homedir(), ".local", "bin"),
       "/Applications/Tailscale.app/Contents/MacOS"];
  let fromShell = "";
  if (!isWin) {
    try {
      const sh = process.env.SHELL || "/bin/zsh";
      fromShell = execFileSync(sh, ["-ilc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { /* keep what we have */ }
  }
  const parts = [...(process.env.PATH ?? "").split(path.delimiter), ...fromShell.split(":"), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(path.delimiter);
}

/** The full path of a program on PATH (with Windows' .exe/.cmd/.bat), or null. */
export function which(name, envPath = process.env.PATH ?? "") {
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, isWin && !path.extname(name) ? name + ext : name);
      try {
        const st = fs.statSync(f);
        if (st.isFile() && (isWin || (st.mode & 0o111))) return f;
      } catch { /* next */ }
    }
  }
  return null;
}

/** How to start a program: Windows runs .cmd/.bat through the shell (Node refuses them otherwise). */
function launch(file, args) {
  if (isWin && /\.(cmd|bat)$/i.test(file)) {
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    return { cmd: `"${file}"`, args: args.map(quote), shell: true };
  }
  return { cmd: file, args, shell: false };
}

/**
 * Run a program. `onLine` gets each line of output as it comes (stdout and stderr); the promise
 * settles with { code, out, err } once it exits. Never through a shell on macOS/Linux.
 */
export function run(file, args, { onLine, timeout = 0, env, input, signal } = {}) {
  return new Promise((resolve) => {
    const l = launch(file, args);
    let child;
    try {
      child = spawn(l.cmd, l.args, { shell: l.shell, env: { ...process.env, ...env }, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e.message ?? e) });
      return;
    }
    let out = "", err = "";
    const lines = (buf, chunk) => {
      buf.rest = (buf.rest ?? "") + chunk;
      let i;
      while ((i = buf.rest.search(/\r?\n|\r(?!\n)/)) >= 0) {
        const line = buf.rest.slice(0, i);
        buf.rest = buf.rest.slice(buf.rest[i] === "\r" && buf.rest[i + 1] === "\n" ? i + 2 : i + 1);
        if (line.trim()) onLine?.(stripAnsi(line));
      }
    };
    const so = {}, se = {};
    child.stdout.on("data", (d) => { const s = d.toString(); out += s; lines(so, s); });
    child.stderr.on("data", (d) => { const s = d.toString(); err += s; lines(se, s); });
    if (input !== undefined) { child.stdin.end(input); }
    let timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    signal?.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", (e) => { err += String(e.message ?? e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      for (const b of [so, se]) if (b.rest?.trim()) onLine?.(stripAnsi(b.rest));
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** A long-running program (a tunnel, the bridge): the child, with output lines. */
export function start(file, args, { onLine, onExit, env } = {}) {
  const l = launch(file, args);
  const child = spawn(l.cmd, l.args, { shell: l.shell, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const feed = (d) => { for (const line of d.toString().split(/\r?\n/)) if (line.trim()) onLine?.(stripAnsi(line)); };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("error", (e) => onLine?.(String(e.message ?? e)));
  child.on("exit", (code, sig) => onExit?.(code, sig));
  return child;
}

/** Stop a child and what it started (gcloud starts python; Windows needs taskkill /T). */
export function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  } else {
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref();
  }
}

export const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");

/** Whether something answers on 127.0.0.1:port. */
export function portOpen(port, host = "127.0.0.1") {
  return new Promise((res) => {
    const s = net.connect(port, host);
    s.setTimeout(1500);
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("timeout", () => { s.destroy(); res(false); });
    s.once("error", () => res(false));
  });
}

/** A free local port (the OS picks it). */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
