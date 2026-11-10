import * as gcloud from "./gcloud.mjs";
import * as tunnels from "./tunnels.mjs";
import { freePort, sleep } from "./env.mjs";
import { getBox, saveBox, settings } from "./store.mjs";

/**
 * What used to be terminal commands, as jobs with steps and a live log:
 * - create a new agentbox on Google Cloud (VM, IAP-only firewall, install, then the setup guide);
 * - open the setup guide of an agentbox (a one-time link through an IAP tunnel, in an app window);
 * - connect an agentbox once its access is set up (Tailscale / Cloudflare address, or an IAP tunnel);
 * - update an agentbox (`sudo agentbox update`, which refuses while agents are working).
 */

const REPO_RE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/;
/** Shell-quote for the VM's bash (only ever our own fixed strings and a checked URL). */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The one-time link `agentbox guide` prints: its token. */
export function guideToken(text) {
  const m = /https?:\/\/localhost:[0-9<>a-z ]*\/\?t=([A-Za-z0-9_-]{16,})/.exec(text) ?? /\/\?t=([A-Za-z0-9_-]{16,})/.exec(text);
  return m ? m[1] : null;
}

/** The install, as one command on the VM: git, the source in /opt/agentbox/src, then bootstrap. */
export function installCommand(repoUrl) {
  if (!REPO_RE.test(repoUrl)) throw new Error("The repository is an https:// git URL");
  return [
    "set -e",
    "command -v git >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git; }",
    `if [ -d /opt/agentbox/src/.git ]; then sudo git -C /opt/agentbox/src pull --ff-only; else sudo mkdir -p /opt/agentbox && sudo git clone ${q(repoUrl)} /opt/agentbox/src; fi`,
    "sudo /opt/agentbox/src/setup/bootstrap.sh --host cloud",
  ].join("; ");
}

/** What `agentbox config get` says about access, parsed from the marker lines below. */
export function parseAccess(out) {
  const get = (k) => (new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1] ?? "").trim();
  return { access: get("ACCESS") || null, tailscale: get("TS") || null, cloudflare: get("CF") || null };
}
const ACCESS_CMD = `echo "ACCESS=$(agentbox config get access 2>/dev/null)"; echo "TS=$(agentbox config get tailscale.hostname 2>/dev/null)"; echo "CF=$(agentbox config get cloudflare.hostname 2>/dev/null)"`;

async function waitForSsh(cloud, job) {
  for (let i = 0; i < 30; i++) {
    const r = await gcloud.ssh(cloud, "true", { timeout: 90_000, signal: job.signal });
    if (r.code === 0) return;
    if (job.signal.aborted) throw new Error("Cancelled");
    if (i === 0) job.log("The VM is starting; waiting for SSH through IAP…");
    await sleep(10_000);
  }
  throw new Error("The VM didn't answer SSH through IAP in 5 minutes");
}

/** Create a VM for agentbox and install it, then open its setup guide. */
export async function createAgentbox(job, { name, cloud, vm }, openGuide) {
  gcloud.checkCloud(cloud);
  if (getBox(name)) throw new Error(`There's already an agentbox called ${name}`);
  const st = await gcloud.status();
  if (!st.installed) throw new Error("gcloud isn't installed on this computer");
  if (!st.account) throw new Error("Sign in to Google Cloud first (Sign in, on the previous screen)");
  for (const step of gcloud.createSteps(cloud, vm)) {
    job.step(step.title);
    await gcloud.runStep(step, job.log);
    if (step.firewall) {
      const open = await gcloud.openSshRules(cloud);
      if (open.length) job.log(`⚠ These firewall rules let anyone reach port 22: ${open.join(", ")}. agentbox doesn't need them (SSH goes through IAP): consider deleting them in the Cloud console.`);
    }
  }
  job.step("Waiting for the VM to start");
  await waitForSsh(cloud, job);
  job.step("Installing agentbox on the VM (about 5–10 minutes)");
  const r = await gcloud.ssh(cloud, installCommand(settings().repoUrl), { onLine: job.log, signal: job.signal });
  if (r.code !== 0) throw new Error(`The install stopped (exit ${r.code}). The log above says why; Retry picks up where it stopped.`);
  // Remember it now (not reachable yet: Connect, once the guide has set up access).
  job.update({ box: name });
  return openGuide(job, name, cloud);
}

/** The setup guide: a one-time link from the VM, its port through IAP, in an app window. */
export async function guide(job, name, cloud, show) {
  job.step("Starting the setup guide on the VM");
  const r = await gcloud.ssh(cloud, "sudo agentbox guide --tunnel", { onLine: (l) => { if (!/\?t=/.test(l)) job.log(l); }, timeout: 120_000, signal: job.signal });
  const token = guideToken(r.out + r.err);
  if (!token) throw new Error(`The guide didn't give a link${r.code ? ` (exit ${r.code})` : ""}. Is agentbox installed on the VM?`);
  job.step("Opening the guide's port through IAP");
  const port = await freePort();
  await tunnels.open(`guide:${name}`, cloud, 7699, port);
  job.step("The setup guide is open: log in to Claude and choose how you'll reach agentbox there");
  show(`http://localhost:${port}/?t=${token}`, name);
  job.wait("When the guide says Finish, click Connect");
  return { box: name, guide: true };
}

/** Add (or refresh) the agentbox's profile from the VM's access settings. */
export async function connect(job, name, cloud) {
  job.step("Reading how this agentbox is reached");
  const r = await gcloud.ssh(cloud, ACCESS_CMD, { timeout: 120_000, signal: job.signal });
  if (r.code !== 0) throw new Error(r.err.trim().split("\n").pop() || "Couldn't reach the VM");
  const a = parseAccess(r.out);
  job.log(`access: ${a.access ?? "not set yet"}`);
  let box;
  if (a.access === "tailscale" && a.tailscale) box = saveBox(name, { url: `https://${a.tailscale}`, cloud, tunnel: null });
  else if (a.access === "cloudflare" && a.cloudflare) box = saveBox(name, { url: `https://${a.cloudflare}`, cloud, tunnel: null });
  else if (a.access === "ssh-tunnel" || a.access === "ssm" || !a.access) {
    // No address of its own: the portal through an IAP tunnel on a port that stays the same.
    const prev = getBox(name);
    const localPort = prev?.tunnel?.localPort ?? await freePort();
    box = saveBox(name, { url: `http://localhost:${localPort}`, cloud, tunnel: { vmPort: 7700, localPort } });
  } else throw new Error(`Access is "${a.access}" but its address isn't set yet: finish the access step in the guide`);
  tunnels.close(`guide:${name}`);
  job.log(`Saved ${name}: ${box.url}`);
  return { box: name, url: box.url };
}

/** `sudo agentbox update` on the VM; it refuses while agents are working. */
export async function update(job, name) {
  const box = getBox(name);
  if (!box?.cloud) throw new Error("The app doesn't know where this agentbox's VM is: Edit it and add its Google Cloud VM");
  job.step(`Updating ${name} (pull, rebuild, restart)`);
  const r = await gcloud.ssh(box.cloud, "sudo agentbox update", { onLine: job.log, signal: job.signal });
  if (r.code !== 0) throw new Error(/working|running|busy/i.test(r.out + r.err) ? "Agents are working; update when they're idle" : `The update stopped (exit ${r.code})`);
  return { box: name };
}
