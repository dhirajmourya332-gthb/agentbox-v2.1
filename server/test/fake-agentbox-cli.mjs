// A stand-in for `agentbox integration … --json` (the integrations workstream's CLI), for the portal
// tests. State lives in $FAKE_CLI_STATE (JSON: { integrations: [...] }); every call is appended to
// $FAKE_CLI_LOG. Shapes follow the minimal agreed contract (server/src/integrations.ts › adaptIntegration).
import fs from "node:fs";

const [, , group, cmd, id, ...rest] = process.argv;
const stateFile = process.env.FAKE_CLI_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const find = () => state.integrations.find((x) => x.id === id);

if (group !== "integration" || !process.argv.includes("--json")) {
  process.stderr.write("usage: agentbox integration <cmd> [id] --json\n");
  process.exit(2);
}

switch (cmd) {
  case "list":
    out(state.integrations.map(({ steps, ...x }) => x));
    break;
  case "status": {
    const it = find();
    if (!it) { process.stderr.write(`unknown integration ${id}\n`); process.exit(1); }
    out(it);
    break;
  }
  case "connect":
  case "verify": {
    const it = find();
    if (!it) { process.stderr.write(`unknown integration ${id}\n`); process.exit(1); }
    console.log(`==> ${cmd} ${id}`);
    console.log("installing things");
    if (id === "broken") {
      process.stderr.write("E: unable to locate package\n");
      process.exit(3);
    }
    if (process.env.FAKE_CLI_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLI_SLEEP)));
    for (const s of it.steps ?? []) s.state = "done";
    it.state = "connected";
    save();
    console.log("done");
    out({ ok: true, id, state: it.state });
    break;
  }
  case "disconnect": {
    const it = find();
    it.state = "disconnected";
    save();
    out({ ok: true, id, state: it.state });
    break;
  }
  case "settings": {
    const it = find();
    const sets = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === "--set") sets.push(rest[++i]);
    for (const kv of sets) {
      const k = kv.slice(0, kv.indexOf("="));
      const v = kv.slice(kv.indexOf("=") + 1);
      const s = it.settings.find((x) => x.key === k);
      if (!s) { process.stderr.write(`unknown setting ${k}\n`); process.exit(1); }
      s.value = v;
    }
    save();
    out({ ok: true, id, settings: it.settings });
    break;
  }
  default:
    process.stderr.write(`unknown command ${cmd}\n`);
    process.exit(2);
}
