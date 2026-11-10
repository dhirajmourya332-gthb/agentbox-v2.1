import { isWin, run, start, which } from "./env.mjs";

/**
 * Google Cloud, through the owner's own `gcloud` (the app never sees a credential: gcloud keeps its
 * logins, and `gcloud auth login` signs in in the browser). Everything reaches the VM through IAP:
 * the VM needs no open port but IAP's range on 22 (and IAP tunnels for the guide / portal).
 *
 * `cloud` is a profile's {provider:"gcp", project?, zone, instance, configuration?}.
 */

export const IAP_RANGE = "35.235.240.0/20";
export const FIREWALL_RULE = "agentbox-allow-iap-ssh";
export const TAG = "agentbox";
export const DEFAULT_VM = { machineType: "e2-standard-4", diskGb: 60, zone: "asia-south1-c" };
export const ZONES = [
  "asia-south1-c", "asia-south1-a", "asia-south2-a", "asia-southeast1-b", "asia-east1-b", "asia-northeast1-b",
  "australia-southeast1-b", "europe-west1-b", "europe-west2-b", "europe-west3-b", "europe-west4-b",
  "us-central1-a", "us-east1-b", "us-east4-a", "us-west1-b", "us-west2-a", "southamerica-east1-b", "me-central1-a",
];
const NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const gcloudPath = () => which("gcloud");

function need() {
  const g = gcloudPath();
  if (!g) throw new Error("gcloud isn't installed on this computer. Install the Google Cloud CLI (cloud.google.com/sdk), then try again.");
  return g;
}

/** --configuration / --project for a cloud (either, both or neither). */
export function scopeArgs(cloud) {
  const a = [];
  if (cloud?.configuration) a.push("--configuration", cloud.configuration);
  if (cloud?.project) a.push("--project", cloud.project);
  return a;
}

export function checkCloud(cloud) {
  if (!cloud?.instance || !NAME_RE.test(cloud.instance)) throw new Error("The VM's name: lowercase letters, digits and -, starting with a letter");
  if (!cloud.zone || !/^[a-z]+-[a-z]+\d+-[a-z]$/.test(cloud.zone)) throw new Error("Pick a zone, e.g. asia-south1-c");
  if (cloud.project && !/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/.test(cloud.project)) throw new Error("That isn't a Google Cloud project id");
  if (cloud.configuration && !/^[A-Za-z0-9_-]{1,64}$/.test(cloud.configuration)) throw new Error("That isn't a gcloud configuration name");
  return cloud;
}

async function json(args) {
  const r = await run(need(), [...args, "--format=json"], { timeout: 60_000 });
  if (r.code !== 0) throw new Error(r.err.trim().split("\n").filter(Boolean).pop() || `gcloud ${args[0]} failed`);
  try { return JSON.parse(r.out || "null"); } catch { return null; }
}

/** What's set up on this computer: gcloud, who's signed in, the configurations. */
export async function status() {
  const g = gcloudPath();
  if (!g) return { installed: false, account: null, configurations: [] };
  const [acct, confs] = await Promise.all([
    run(g, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { timeout: 30_000 }),
    json(["config", "configurations", "list"]).catch(() => []),
  ]);
  return {
    installed: true,
    account: acct.code === 0 ? acct.out.trim().split("\n")[0] || null : null,
    configurations: (confs ?? []).map((c) => ({ name: c.name, active: !!c.is_active, project: c.properties?.core?.project ?? null, account: c.properties?.core?.account ?? null })),
  };
}

/** Sign in: gcloud opens the browser; the owner signs in there. */
export const login = (onLine) => run(need(), ["auth", "login", "--brief"], { onLine, timeout: 10 * 60_000 });

export async function projects(configuration) {
  const list = await json([...(configuration ? ["--configuration", configuration] : []), "projects", "list"]);
  return (list ?? []).map((p) => ({ id: p.projectId, name: p.name }));
}

export async function instances(cloud) {
  const list = await json([...scopeArgs(cloud), "compute", "instances", "list"]);
  return (list ?? []).map((i) => ({ name: i.name, zone: String(i.zone ?? "").split("/").pop(), status: i.status, tags: i.tags?.items ?? [] }));
}

/** Run a command on the VM over IAP SSH (no open port), streaming its output. */
export function ssh(cloud, command, { onLine, timeout = 30 * 60_000, signal } = {}) {
  checkCloud(cloud);
  return run(need(), [...scopeArgs(cloud), "compute", "ssh", cloud.instance, "--zone", cloud.zone, "--tunnel-through-iap", "--quiet", "--command", command],
    { onLine, timeout, signal });
}

/**
 * A port on the VM's loopback (the portal and the guide listen on 127.0.0.1 only), on this
 * computer's localhost:<localPort>: an SSH port forward through IAP, so the VM needs nothing open but
 * SSH from IAP's range. Returns the gcloud child; it stays up until stopped.
 */
export function tunnel(cloud, vmPort, localPort, { onLine, onExit } = {}) {
  checkCloud(cloud);
  return start(need(), forwardArgs(cloud, vmPort, localPort), { onLine, onExit });
}

export function forwardArgs(cloud, vmPort, localPort) {
  const p = Number(vmPort), l = Number(localPort);
  if (!Number.isInteger(p) || !Number.isInteger(l) || p < 1 || p > 65535 || l < 1024 || l > 65535) throw new Error("Bad port");
  // ssh's own flags after "--" (OpenSSH; on Windows gcloud uses PuTTY's plink, which takes -N and -L too).
  const sshFlags = isWin ? ["-N", "-L", `${l}:127.0.0.1:${p}`]
    : ["-N", "-L", `127.0.0.1:${l}:127.0.0.1:${p}`, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
  return [...scopeArgs(cloud), "compute", "ssh", cloud.instance, "--zone", cloud.zone, "--tunnel-through-iap", "--quiet", "--", ...sshFlags];
}

/** The gcloud steps that make a VM for agentbox (exported for tests and the log). */
export function createSteps(cloud, vm = {}) {
  checkCloud(cloud);
  const s = scopeArgs(cloud);
  const machineType = vm.machineType ?? DEFAULT_VM.machineType;
  const diskGb = Number(vm.diskGb ?? DEFAULT_VM.diskGb);
  if (!/^[a-z0-9]+-[a-z0-9-]+$/.test(machineType)) throw new Error("That isn't a machine type, e.g. e2-standard-4");
  if (!Number.isInteger(diskGb) || diskGb < 30 || diskGb > 2000) throw new Error("Disk: 30 to 2000 GB");
  return [
    { title: "Turning on the Compute Engine and IAP APIs", args: [...s, "services", "enable", "compute.googleapis.com", "iap.googleapis.com"] },
    { title: "Allowing SSH only from Google's IAP (no open ports)", firewall: true,
      args: [...s, "compute", "firewall-rules", "create", FIREWALL_RULE, "--network", "default", "--direction", "INGRESS",
        "--allow", "tcp:22", "--source-ranges", IAP_RANGE, "--target-tags", TAG, "--description", "agentbox: SSH through IAP only"] },
    { title: `Creating the VM ${cloud.instance} (${machineType}, ${diskGb} GB, Ubuntu 24.04)`,
      args: [...s, "compute", "instances", "create", cloud.instance, "--zone", cloud.zone, "--machine-type", machineType,
        "--image-family", "ubuntu-2404-lts-amd64", "--image-project", "ubuntu-os-cloud",
        "--boot-disk-size", `${diskGb}GB`, "--boot-disk-type", "pd-balanced", "--tags", TAG,
        "--shielded-secure-boot", "--shielded-vtpm", "--shielded-integrity-monitoring"] },
  ];
}

/** Run one create step; "already exists" is fine (re-running setup picks up where it stopped). */
export async function runStep(step, onLine) {
  const r = await run(need(), step.args, { onLine, timeout: 15 * 60_000 });
  if (r.code === 0) return { ok: true };
  if (/already exists/i.test(r.err)) { onLine?.("(already there)"); return { ok: true, existed: true }; }
  throw new Error(r.err.trim().split("\n").filter(Boolean).pop() || `gcloud exited with ${r.code}`);
}

/** Firewall rules on the default network that let anyone reach port 22 (Google's default-allow-ssh). */
export async function openSshRules(cloud) {
  const rules = await json([...scopeArgs(cloud), "compute", "firewall-rules", "list"]).catch(() => []);
  return (rules ?? []).filter((r) => r.direction === "INGRESS" && !r.disabled && (r.sourceRanges ?? []).includes("0.0.0.0/0")
    && (r.allowed ?? []).some((a) => a.IPProtocol === "all" || (a.IPProtocol === "tcp" && (!a.ports || a.ports.some((p) => p === "22" || /^\d+-\d+$/.test(p) && Number(p.split("-")[0]) <= 22 && Number(p.split("-")[1]) >= 22)))))
    .filter((r) => !r.targetTags || r.targetTags.includes(TAG))
    .map((r) => r.name);
}
