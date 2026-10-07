import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 7700);

const SERVICES = [
  "agentbox-xvfb",
  "agentbox-wm",
  "agentbox-vnc",
  "agentbox-novnc",
  "agentbox-ttyd",
  "agentbox-chromium",
];

async function serviceState(name: string): Promise<string> {
  try {
    const { stdout } = await run("systemctl", ["is-active", name]);
    return stdout.trim();
  } catch (err: any) {
    return (err.stdout ?? "unknown").trim() || "unknown";
  }
}

async function browserState(): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { Browser?: string };
    return { ok: true, version: body.Browser };
  } catch {
    return { ok: false };
  }
}

async function cliVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 20000 });
    return stdout.split("\n")[0].trim();
  } catch {
    return null;
  }
}

const app = Fastify({ logger: true });

app.get("/api/health", async () => {
  const [services, browser, claude, gh, aws] = await Promise.all([
    Promise.all(SERVICES.map(async (s) => [s, await serviceState(s)] as const)),
    browserState(),
    cliVersion("claude"),
    cliVersion("gh"),
    cliVersion("aws"),
  ]);
  return {
    services: Object.fromEntries(services),
    browser,
    tools: { claude, gh, aws },
  };
});

app.register(fastifyStatic, { root: path.resolve(here, "../../web") });

await app.listen({ host: "0.0.0.0", port });
