import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * What the app remembers.
 *
 * - **Agentboxes** are the CLI's profiles (`~/.config/agentbox/profiles.json`, 0600), so the app and
 *   `agentbox` on this computer see the same list. The app adds two optional fields the CLI ignores:
 *   `cloud` (where the VM is, for tunnels and updates: {provider:"gcp", project, zone, instance,
 *   configuration?}) and `tunnel` ({vmPort, localPort}: reach the portal through a Google Cloud IAP
 *   tunnel, for agentboxes in ssh-tunnel access mode).
 * - **Settings** (which bridges were on, launch at login, notifications) live in the app's own folder.
 */

export const CONFIG_DIR = process.env.AGENTBOX_CLIENT_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentbox");
const PROFILES = () => path.join(CONFIG_DIR, "profiles.json");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function readProfiles() {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILES(), "utf8"));
    return { default: p.default ?? null, profiles: p.profiles && typeof p.profiles === "object" ? p.profiles : {} };
  } catch {
    return { default: null, profiles: {} };
  }
}

function writeProfiles(p) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = PROFILES() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, PROFILES());
}

/** A portal URL as the profiles keep it: http(s), no path, no trailing slash. */
export function cleanUrl(u) {
  let url;
  try { url = new URL(String(u ?? "").trim()); } catch { throw new Error("Enter the portal's address, e.g. https://agentbox.your-tailnet.ts.net"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("The address starts with https:// (or http://localhost for a tunnel)");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Plain http is only for a tunnel on this computer (http://localhost:…). Use the https address.");
  }
  return `${url.protocol}//${url.host}`;
}

export function listBoxes() {
  const p = readProfiles();
  return Object.entries(p.profiles).map(([name, x]) => ({
    name, url: String(x.url ?? "").replace(/\/+$/, ""), default: p.default === name,
    lima: x.lima ?? null, cloud: x.cloud ?? null, tunnel: x.tunnel ?? null,
  })).sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}

export const getBox = (name) => listBoxes().find((b) => b.name === name) ?? null;

export function saveBox(name, fields, { makeDefault = false } = {}) {
  if (!NAME_RE.test(String(name ?? ""))) throw new Error("A name: letters, digits, . _ - (up to 40), e.g. mumbai");
  const p = readProfiles();
  const prev = p.profiles[name] ?? {};
  const next = { ...prev, ...fields, url: cleanUrl(fields.url ?? prev.url) };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  p.profiles[name] = next;
  if (makeDefault || !p.default || !p.profiles[p.default]) p.default = name;
  writeProfiles(p);
  return getBox(name);
}

export function removeBox(name) {
  const p = readProfiles();
  delete p.profiles[name];
  if (p.default === name) p.default = Object.keys(p.profiles)[0] ?? null;
  writeProfiles(p);
}

export function setDefault(name) {
  const p = readProfiles();
  if (!p.profiles[name]) return;
  p.default = name;
  writeProfiles(p);
}

// --- the app's own settings ------------------------------------------------------------------------

let settingsFile = null;
const DEFAULTS = { bridges: {}, launchAtLogin: false, notify: true, lastBox: null, repoUrl: "https://github.com/dhirajmourya332-gthb/agentbox-v2.1" };

export function initSettings(dir) { settingsFile = path.join(dir, "settings.json"); }

export function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) }; } catch { return { ...DEFAULTS }; }
}

export function updateSettings(patch) {
  const next = { ...settings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
