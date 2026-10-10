// The agentbox setup guide (docs/GUIDE.md). Run by the agentbox-guide systemd unit as the agent
// user: `node --import tsx server.ts`. Listens on 127.0.0.1:<ports.guide> only.
import fs from "node:fs";
import { parse } from "yaml";
import { createGuide } from "./src/app.ts";

const configFile = process.env.AGENTBOX_CONFIG || "/etc/agentbox/config.yaml";
let conf: any = {};
try { conf = parse(fs.readFileSync(configFile, "utf8")) ?? {}; } catch (e: any) {
  console.error(`guide: can't read ${configFile} (${e.code ?? e.message}); using defaults`);
}
const port = Number(process.env.AGENTBOX_GUIDE_PORT || conf?.ports?.guide || 7699);

const guide = await createGuide({ configFile, logger: true });
await guide.app.listen({ host: "127.0.0.1", port });
guide.app.log.info(`setup guide on http://127.0.0.1:${port} (state in ${guide.stateDir})`);

const shutdown = async () => {
  try { await guide.close(); } finally { process.exit(0); }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
