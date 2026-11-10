// The app's own page: your agentboxes on the left, the open one's portal on the right (a separate,
// locked-down view the main process lays over .portal), and the panels for adding agentboxes, the
// device bridge, setup on Google Cloud, updates and settings. window.agentbox is the preload's API.

const A = window.agentbox;
const app = document.getElementById("app");

const state = {
  info: { platform: "" }, boxes: [], jobs: [], settings: {}, attention: 0,
  view: { kind: "loading" }, portalShown: null, portalError: {}, busy: false, error: null,
  forms: {}, // per view: what's typed so far
  cloud: null, projects: [], instances: [], defaults: { zones: [], vm: {} }, jobLines: {}, python: undefined,
};

// --- a tiny DOM helper -----------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const form = (key) => (state.forms[key] ??= {});
const input = (key, field, attrs = {}) => h("input", {
  class: "text", id: `${key}-${field}`, value: form(key)[field] ?? attrs.value ?? "", ...attrs,
  oninput: (e) => { form(key)[field] = e.target.value; attrs.oninput?.(e); },
});
const select = (key, field, options, attrs = {}) => h("select", {
  class: "text", id: `${key}-${field}`, ...attrs,
  onchange: (e) => { form(key)[field] = e.target.value; attrs.onchange?.(e); render(); },
}, options.map(([v, label]) => h("option", { value: v, selected: (form(key)[field] ?? attrs.default) === v || undefined }, label)));

const go = (view) => { state.view = view; state.error = null; render(); };
async function act(fn) {
  state.busy = true; state.error = null; render();
  try { return await fn(); } catch (e) { state.error = cleanError(e); } finally { state.busy = false; render(); }
}
const cleanError = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const boxByName = (n) => state.boxes.find((b) => b.name === n);

// --- data ----------------------------------------------------------------------------------------
async function refresh() {
  [state.boxes, state.jobs, state.settings] = await Promise.all([A.boxes.list(), A.jobs.list(), A.settings.get()]);
}

A.on("bridge", (b) => { const x = boxByName(b.name); if (x) x.bridge = b; render(); });
A.on("tunnel", (t) => { const x = boxByName(t.key); if (x) x.tunnel = t; render(); });
A.on("job", async (j) => {
  const i = state.jobs.findIndex((x) => x.id === j.id);
  if (i < 0) state.jobs.unshift(j); else state.jobs[i] = j;
  if (j.state !== "running") await refresh();
  render();
});
A.on("job:line", ({ id, text }) => {
  (state.jobLines[id] ??= []).push(text);
  const log = document.getElementById(`log-${id}`);
  if (log) { const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40; log.append(text + "\n"); if (stick) log.scrollTop = log.scrollHeight; }
});
A.on("attention", (n) => { state.attention = n; render(); });
A.on("app:open", ({ name, route }) => openBox(name, route));
A.on("app:reload", () => { if (state.view.kind === "portal") A.portal.reload(state.view.name); });
A.on("portal:error", ({ name, error }) => { state.portalError[name] = error; render(); });
A.on("portal:loaded", ({ name }) => { delete state.portalError[name]; render(); });

// --- the portal view ---------------------------------------------------------------------------------
const portalRect = () => document.querySelector(".portal")?.getBoundingClientRect();
async function openBox(name, route) {
  state.view = { kind: "portal", name, route };
  state.portalShown = null;
  delete state.portalError[name];
  render();
}
async function syncPortal() {
  const v = state.view;
  if (v.kind !== "portal") {
    if (state.portalShown) { state.portalShown = null; await A.portal.hide(); }
    return;
  }
  const r = portalRect();
  if (!r) return;
  const bounds = { x: r.x, y: r.y, width: r.width, height: r.height };
  if (state.portalShown === v.name && !v.route) { A.portal.resize(bounds); return; }
  state.portalShown = v.name;
  const route = v.route;
  v.route = null;
  try { await A.portal.show(v.name, bounds, route); }
  catch (e) { state.portalShown = null; state.portalError[v.name] = cleanError(e); await A.portal.hide(); render(); }
}
new ResizeObserver(() => { if (state.view.kind === "portal" && state.portalShown) { const r = portalRect(); if (r) A.portal.resize({ x: r.x, y: r.y, width: r.width, height: r.height }); } }).observe(document.body);

// --- pieces ----------------------------------------------------------------------------------------
const BRIDGE_ON = ["connected", "starting", "reconnecting", "waiting"];
function bridgeSwitch(b) {
  const s = b.bridge ?? { state: "off" };
  const label = s.state === "off" ? "Device bridge" : s.state === "connected" ? `Bridge on${s.devices?.length ? ` · ${s.devices.length} device${s.devices.length > 1 ? "s" : ""}` : " · no devices"}`
    : s.state === "error" ? `Bridge: ${s.detail ?? "error"}` : `Bridge: ${s.detail ?? s.state}`;
  return h("label", { class: "switch", title: "Share USB devices on this computer with the agents (docs/BENCH.md). Nothing listens here: the bridge dials out." },
    h("input", { type: "checkbox", checked: BRIDGE_ON.includes(s.state), onchange: (e) => act(() => A.bridge.set(b.name, e.target.checked)) }),
    h("span", { class: "state", title: s.detail ?? "" }, label));
}
function boxDot(b) {
  if (b.tunnel?.state === "error" || state.portalError[b.name]) return "bad";
  if (b.tunnel && ["starting", "reconnecting"].includes(b.tunnel.state)) return "warn";
  if (!b.tunnel || b.tunnel.state === "up") return "ok";
  return "";
}

function sidebar() {
  const v = state.view;
  const running = state.jobs.filter((j) => j.state === "running").length;
  return h("nav", { class: "side", "aria-label": "Agentboxes" },
    h("div", { class: "side-top" }, h("span", { class: "brand" }, h("span", { class: "brand-mark" }, "a"), "agentbox")),
    h("div", { class: "side-label" }, "Your agentboxes"),
    h("div", { class: "boxes" },
      state.boxes.map((b) => h("button", { class: "box-item", "aria-current": v.kind !== "add" && v.name === b.name ? "true" : undefined, onclick: () => openBox(b.name), title: b.url },
        h("span", { class: `dot ${boxDot(b)}` }),
        h("span", { class: "name" }, b.name, h("span", { class: "sub" }, b.tunnel ? `${b.cloud?.instance ?? "tunnel"} · tunnel` : b.url.replace(/^https?:\/\//, ""))),
        BRIDGE_ON.includes(b.bridge?.state) ? h("span", { class: "chip-bridge on" }, "bridge") : null)),
      !state.boxes.length ? h("p", { class: "hint pad" }, "None yet.") : null),
    h("div", { class: "side-bottom" },
      h("button", { class: "side-link", "aria-current": v.kind?.startsWith("add") ? "true" : undefined, onclick: () => go({ kind: "add" }) }, "+ Add an agentbox"),
      h("button", { class: "side-link", "aria-current": v.kind === "jobs" ? "true" : undefined, onclick: () => go({ kind: "jobs" }) }, "Setup and updates", running ? h("span", { class: "count" }, h("span", { class: "spin" })) : null),
      h("button", { class: "side-link", "aria-current": v.kind === "settings" ? "true" : undefined, onclick: () => go({ kind: "settings" }) }, "Settings",
        state.attention ? h("span", { class: "count" }, `${state.attention} need you`) : null)));
}

function toolbar(b) {
  return h("div", { class: "toolbar" },
    h("span", { class: "title" }, b.name),
    h("span", { class: "url" }, b.url),
    h("span", { class: "spacer" }),
    bridgeSwitch(b),
    b.cloud ? h("button", { class: "btn sm", onclick: () => update(b.name), title: "Pull, rebuild and restart this agentbox (refuses while agents are working)" }, "Update") : null,
    h("button", { class: "btn sm ghost", onclick: () => A.portal.reload(b.name), title: "Reload (⌘R / Ctrl+R)" }, "Reload"),
    h("button", { class: "btn sm ghost", onclick: () => A.portal.external(b.name), title: "Open in your browser" }, "Browser"),
    h("button", { class: "btn sm", onclick: () => go({ kind: "box", name: b.name }) }, "Manage"));
}

async function update(name) {
  const id = await act(() => A.flow.update(name));
  if (id) go({ kind: "jobs", id });
}

// --- panels ------------------------------------------------------------------------------------------
function panel(...kids) { return h("div", { class: "panel" }, h("div", { class: "panel-inner" }, ...kids, state.error ? h("div", { class: "error", role: "alert" }, state.error) : null)); }

function welcome() {
  return panel(
    h("div", null, h("h1", null, "Welcome to agentbox"), h("p", { class: "lede" }, "Your agentboxes in one window, the device bridge one switch away, and setup and updates without a terminal.")),
    addChoices());
}

function addChoices() {
  return h("div", { class: "cards" },
    h("button", { class: "choice", onclick: () => go({ kind: "add-url" }) }, h("strong", null, "Connect by address"),
      h("span", { class: "hint" }, "Its portal address, e.g. https://agentbox.your-tailnet.ts.net. This computer must be on your tailnet.")),
    h("button", { class: "choice", onclick: () => go({ kind: "add-gcp", mode: "existing" }) }, h("strong", null, "A VM on Google Cloud"),
      h("span", { class: "hint" }, "An agentbox you already run on Compute Engine: the app reads its address, or tunnels to it through IAP.")),
    h("button", { class: "choice", onclick: () => go({ kind: "add-gcp", mode: "create" }) }, h("strong", null, "Create a new agentbox"),
      h("span", { class: "hint" }, "On Google Cloud: the VM (no open ports), the install, then the setup guide, all from here.")));
}

function addPanel() {
  return panel(h("div", null, h("h1", null, "Add an agentbox"), h("p", { class: "lede" }, "Agentboxes you add here are the same profiles the agentbox command uses on this computer.")), addChoices());
}

function addUrlPanel() {
  const f = form("url");
  return panel(
    h("div", null, h("h1", null, "Connect by address")),
    h("div", { class: "card" },
      h("div", { class: "field" }, h("label", { for: "url-url" }, "Portal address"), input("url", "url", { placeholder: "https://agentbox.your-tailnet.ts.net" })),
      h("div", { class: "field" }, h("label", { for: "url-name" }, "Name"), input("url", "name", { placeholder: "mumbai" }), h("span", { class: "hint" }, "Short, for this list and the CLI's --profile.")),
      f.tested ? h("div", { class: f.tested.ok ? "ok-box" : "warn-box" }, f.tested.ok ? `The portal answers (${f.tested.access ?? "access"} mode).` : f.tested.error) : null,
      h("div", { class: "row" },
        h("button", { class: "btn", disabled: state.busy || undefined, onclick: () => act(async () => { f.tested = await A.boxes.test(f.url ?? ""); }) }, "Test"),
        h("button", { class: "btn primary", disabled: state.busy || undefined, onclick: () => act(async () => {
          const b = await A.boxes.save((f.name ?? "").trim(), { url: f.url }, !state.boxes.length);
          state.forms.url = {};
          await refresh();
          openBox(b.name);
        }) }, "Add"))));
}

async function loadCloud() {
  state.cloud = await A.cloud.status();
  state.defaults = await A.cloud.defaults();
  render();
}

function cloudOf(f) {
  return { provider: "gcp", configuration: f.configuration || undefined, project: f.project || undefined, zone: f.zone || state.defaults.vm.zone, instance: (f.instance ?? "").trim() };
}

function gcpPanel(mode) {
  const f = form(`gcp-${mode}`);
  const key = `gcp-${mode}`;
  if (!state.cloud) { void loadCloud(); return panel(h("h1", null, mode === "create" ? "Create a new agentbox" : "A VM on Google Cloud"), h("p", { class: "hint" }, h("span", { class: "spin" }), " Looking for gcloud…")); }
  const c = state.cloud;
  const signIn = h("div", { class: "card" },
    h("h2", null, "1. Google Cloud on this computer"),
    !c.installed ? h("div", { class: "warn-box" }, "gcloud isn't installed. Install the Google Cloud CLI (", h("a", { href: "https://cloud.google.com/sdk/docs/install", target: "_blank" }, "cloud.google.com/sdk"), "), then ", h("button", { class: "btn sm", onclick: () => { state.cloud = null; render(); } }, "Check again"))
      : c.account ? h("div", { class: "ok-box" }, `Signed in as ${c.account}.`)
      : h("div", { class: "row" }, h("span", null, "Not signed in."), h("button", { class: "btn primary sm", onclick: async () => { const id = await act(() => A.cloud.login()); if (id) go({ kind: "jobs", id, back: state.view }); } }, "Sign in (opens your browser)")),
    c.configurations.length > 1 ? h("div", { class: "field" }, h("label", { for: `${key}-configuration` }, "gcloud configuration"),
      select(key, "configuration", [["", "The active one"], ...c.configurations.map((x) => [x.name, `${x.name}${x.project ? ` · ${x.project}` : ""}${x.account ? ` · ${x.account}` : ""}`])])) : null);
  const where = h("div", { class: "card" },
    h("h2", null, mode === "create" ? "2. The new VM" : "2. Which VM"),
    h("div", { class: "grid2" },
      h("div", { class: "field" }, h("label", { for: `${key}-project` }, "Project id"), input(key, "project", { placeholder: c.configurations.find((x) => x.name === f.configuration || (!f.configuration && x.active))?.project ?? "my-project" }),
        h("span", { class: "hint" }, "Empty: the configuration's project.")),
      h("div", { class: "field" }, h("label", { for: `${key}-zone` }, "Zone"), select(key, "zone", state.defaults.zones.map((z) => [z, z]), { default: state.defaults.vm.zone }),
        h("span", { class: "hint" }, "Near you: tools that talk to devices over the bridge need a short round trip.")),
      h("div", { class: "field" }, h("label", { for: `${key}-instance` }, "VM name"), input(key, "instance", { placeholder: "agentbox-mumbai" })),
      h("div", { class: "field" }, h("label", { for: `${key}-name` }, "Name in this app"), input(key, "name", { placeholder: "mumbai" }))),
    mode === "existing" ? h("div", { class: "row" },
      h("button", { class: "btn sm", disabled: state.busy || !c.account || undefined, onclick: () => act(async () => { state.instances = await A.cloud.instances(cloudOf(f)); }) }, "List VMs"),
      state.instances.map((i) => h("button", { class: "btn sm ghost", onclick: () => { f.instance = i.name; f.zone = i.zone; f.name ??= i.name.replace(/^agentbox-/, ""); render(); } }, `${i.name} (${i.zone}, ${i.status.toLowerCase()})`))) : null,
    mode === "create" ? h("div", { class: "grid2" },
      h("div", { class: "field" }, h("label", { for: `${key}-machine` }, "Machine type"), input(key, "machine", { placeholder: state.defaults.vm.machineType })),
      h("div", { class: "field" }, h("label", { for: `${key}-disk` }, "Disk (GB)"), input(key, "disk", { placeholder: String(state.defaults.vm.diskGb), inputmode: "numeric" }))) : null,
    mode === "create" ? h("p", { class: "hint" }, "The VM gets no open ports: SSH only from Google's IAP range, and the portal through Tailscale (or an IAP tunnel). Creating it is billed to the project.") : null);
  const go_ = h("div", { class: "row" },
    h("button", { class: "btn primary", disabled: state.busy || !c.account || undefined, onclick: () => act(async () => {
      const name = (f.name || f.instance || "").trim().replace(/^agentbox-/, "");
      const cloud = cloudOf(f);
      const id = mode === "create"
        ? await A.flow.create({ name, cloud, vm: { machineType: f.machine || undefined, diskGb: f.disk ? Number(f.disk) : undefined } })
        : await A.flow.connect(name, cloud);
      go({ kind: "jobs", id });
    }) }, mode === "create" ? "Create and install" : "Connect"),
    mode === "existing" ? h("span", { class: "hint" }, "Reads its access settings over IAP SSH: a Tailscale or Cloudflare address, or else a tunnel.") : null);
  return panel(h("div", null, h("h1", null, mode === "create" ? "Create a new agentbox" : "A VM on Google Cloud"),
    h("p", { class: "lede" }, mode === "create" ? "Everything the README's terminal steps did: the VM, the install, then the setup guide in a window here." : "Uses your gcloud sign-in; nothing is opened on the VM.")),
    signIn, where, go_);
}

function jobMark(s) { return h("span", { class: `mark ${s}` }, s === "done" ? "✓" : s === "failed" ? "✕" : s === "waiting" ? "!" : s === "running" ? "▸" : "·"); }

function jobsPanel() {
  const v = state.view;
  if (v.id) {
    const j = state.jobs.find((x) => x.id === v.id);
    if (!j) return panel(h("p", null, "That job is gone."));
    if (!state.jobLines[j.id]) { state.jobLines[j.id] = []; A.jobs.get(j.id).then((full) => { if (full) { state.jobLines[j.id] = full.lines; render(); } }); }
    const box = j.meta?.box ? boxByName(j.meta.box) : null;
    const canConnect = (j.kind === "create" || j.kind === "guide") && j.meta?.box;
    const log = h("pre", { class: "log", id: `log-${j.id}` }, (state.jobLines[j.id] ?? []).join("\n") + "\n");
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    return panel(
      h("div", { class: "row" }, h("button", { class: "btn sm ghost", onclick: () => go({ kind: "jobs" }) }, "← All"), h("h1", null, j.title)),
      h("ul", { class: "steps" }, j.steps.map((s) => h("li", null, jobMark(s.state), h("span", null, s.title)))),
      j.state === "running" ? h("div", { class: "row" }, h("span", { class: "spin" }), h("span", { class: "hint" }, "Working…"), h("button", { class: "btn sm ghost", onclick: () => A.jobs.cancel(j.id) }, "Cancel")) : null,
      j.error ? h("div", { class: "error" }, j.error) : null,
      j.state !== "running" && j.state !== "done" && j.kind === "create" ? h("div", { class: "row" }, h("button", { class: "btn", onclick: () => act(async () => { const id = await A.flow.create({ name: j.meta.box, cloud: j.meta.cloud }); go({ kind: "jobs", id }); }) }, "Retry"),
        h("span", { class: "hint" }, "Steps already done are skipped.")) : null,
      canConnect && j.state === "done" ? h("div", { class: "card" },
        h("h2", null, "When the guide says Finish"),
        h("p", { class: "hint" }, "Connect reads the address the guide set up (Tailscale or Cloudflare), or opens a tunnel, and adds it to your agentboxes."),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onclick: () => act(async () => { const id = await A.flow.connect(j.meta.box, j.meta.cloud ?? box?.cloud); go({ kind: "jobs", id }); }) }, `Connect ${j.meta.box}`),
          h("button", { class: "btn", onclick: () => act(async () => { const id = await A.flow.guide(j.meta.box, j.meta.cloud ?? box?.cloud); go({ kind: "jobs", id }); }) }, "Open the guide again"))) : null,
      j.kind === "connect" && j.state === "done" ? h("button", { class: "btn primary", onclick: () => openBox(j.meta.box) }, `Open ${j.meta.box}`) : null,
      j.kind === "login" && j.state === "done" ? h("button", { class: "btn primary", onclick: () => { state.cloud = null; go(v.back ?? { kind: "add" }); } }, "Continue") : null,
      log);
  }
  return panel(
    h("div", null, h("h1", null, "Setup and updates"), h("p", { class: "lede" }, "What the app has done for you here, with each step's output.")),
    state.jobs.length ? state.jobs.map((j) => h("button", { class: "job-row", onclick: () => go({ kind: "jobs", id: j.id }) },
      j.state === "running" ? h("span", { class: "spin" }) : jobMark(j.state === "done" ? "done" : "failed"),
      h("span", { class: "grow" }, j.title, h("span", { class: "hint" }, ` · ${j.steps.at(-1)?.title ?? ""}`)),
      h("span", { class: "hint" }, new Date(j.started_at).toLocaleTimeString()))) : h("p", { class: "hint" }, "Nothing yet. Updates and new agentboxes show up here."));
}

function boxPanel(b) {
  if (!b) return panel(h("p", null, "That agentbox is gone."));
  const f = form(`box-${b.name}`);
  const s = b.bridge ?? { state: "off" };
  if (state.python === undefined) { state.python = null; A.bridge.python().then((p) => { state.python = p || false; render(); }); }
  return panel(
    h("div", { class: "row" }, h("button", { class: "btn sm ghost", onclick: () => openBox(b.name) }, "← Portal"), h("h1", null, b.name)),
    h("div", { class: "card" },
      h("h2", null, "Device bridge"),
      h("p", { class: "hint" }, "Shares USB serial devices on this computer (ESP32, Arduino…) with the agents, as /dev/bench/<id> on the VM. The agentbox's Device bridge integration must be connected; what's shared is set there and on this computer."),
      bridgeSwitch(b),
      state.python === false ? h("div", { class: "warn-box" }, "It needs Python 3.9 or newer on this computer (python.org).") : state.python ? h("span", { class: "hint" }, `Python ${state.python.version}`) : null,
      s.devices?.length ? h("p", null, "Sharing: ", s.devices.join(", ")) : null,
      s.lines?.length ? h("pre", { class: "log short" }, s.lines.join("\n")) : null),
    h("div", { class: "card" },
      h("h2", null, "Connection"),
      h("dl", { class: "kv" },
        h("dt", null, "Portal"), h("dd", null, b.url),
        b.tunnel ? [h("dt", null, "Tunnel"), h("dd", null, `${b.tunnel.state}${b.tunnel.error ? ` · ${b.tunnel.error}` : ""}`)] : null,
        b.cloud ? [h("dt", null, "Google Cloud VM"), h("dd", null, `${b.cloud.instance} · ${b.cloud.zone}${b.cloud.project ? ` · ${b.cloud.project}` : ""}${b.cloud.configuration ? ` · config ${b.cloud.configuration}` : ""}`)] : null,
        b.lima ? [h("dt", null, "Lima VM"), h("dd", null, b.lima.vm)] : null),
      h("div", { class: "field" }, h("label", { for: `box-${b.name}-url` }, "Address"), input(`box-${b.name}`, "url", { value: b.url })),
      h("div", { class: "row" },
        h("button", { class: "btn", disabled: state.busy || undefined, onclick: () => act(async () => { await A.boxes.save(b.name, { url: f.url ?? b.url }); await refresh(); }) }, "Save"),
        b.default ? h("span", { class: "hint" }, "The CLI's default") : h("button", { class: "btn ghost", onclick: () => act(async () => { await A.boxes.setDefault(b.name); await refresh(); }) }, "Make the CLI's default"))),
    b.cloud ? h("div", { class: "card" },
      h("h2", null, "On the VM"),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => update(b.name) }, "Update agentbox"),
        h("button", { class: "btn", onclick: () => act(async () => { const id = await A.flow.guide(b.name, b.cloud); go({ kind: "jobs", id }); }) }, "Open the setup guide"),
        h("button", { class: "btn", onclick: () => act(async () => { const id = await A.flow.connect(b.name, b.cloud); go({ kind: "jobs", id }); }) }, "Re-read its address")),
      h("p", { class: "hint" }, "Update pulls the latest agentbox, rebuilds and restarts it; it refuses while agents are working.")) : null,
    h("div", { class: "card" },
      h("h2", null, "Remove"),
      h("p", { class: "hint" }, "Removes it from this app and the CLI on this computer. The agentbox itself isn't touched."),
      f.confirmRemove ? h("div", { class: "row" },
        h("button", { class: "btn danger", onclick: () => act(async () => { await A.boxes.remove(b.name); await refresh(); go(state.boxes[0] ? { kind: "portal", name: state.boxes[0].name } : { kind: "welcome" }); }) }, `Remove ${b.name}`),
        h("button", { class: "btn ghost", onclick: () => { f.confirmRemove = false; render(); } }, "Cancel"))
        : h("button", { class: "btn danger", onclick: () => { f.confirmRemove = true; render(); } }, "Remove…")));
}

function settingsPanel() {
  const s = state.settings;
  const toggle = (k, label, hint) => h("label", { class: "switch" }, h("input", { type: "checkbox", checked: !!s[k], onchange: (e) => act(async () => { state.settings = await A.settings.set({ [k]: e.target.checked }); }) }),
    h("span", null, label, hint ? h("span", { class: "hint" }, ` · ${hint}`) : null));
  const f = form("settings");
  return panel(
    h("div", null, h("h1", null, "Settings")),
    h("div", { class: "card" },
      toggle("launchAtLogin", "Open at login", "in the background, so bridges that were on come back on"),
      toggle("notify", "Notifications", `when something needs you${state.attention ? ` (${state.attention} now)` : ""}`)),
    h("div", { class: "card" },
      h("div", { class: "field" }, h("label", { for: "settings-repoUrl" }, "agentbox repository (for new agentboxes)"), input("settings", "repoUrl", { value: s.repoUrl })),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => act(async () => { state.settings = await A.settings.set({ repoUrl: f.repoUrl ?? s.repoUrl }); }) }, "Save"))),
    h("p", { class: "hint" }, `Profiles: ${state.info.configDir}/profiles.json (shared with the agentbox command) · v${state.info.version} · ${state.info.platform}`));
}

function portalArea(b) {
  const err = state.portalError[b.name];
  const t = b.tunnel;
  return h("div", { class: "portal" },
    err ? h("div", { class: "portal-msg" }, h("div", null, h("p", null, h("strong", null, `Couldn't open ${b.name}`)), h("p", { class: "hint" }, err),
      h("div", { class: "row center" }, h("button", { class: "btn", onclick: () => openBox(b.name) }, "Try again"), h("button", { class: "btn ghost", onclick: () => go({ kind: "box", name: b.name }) }, "Manage"))))
    : t && t.state !== "up" ? h("div", { class: "portal-msg" }, h("p", { class: "hint" }, h("span", { class: "spin" }), ` Opening the tunnel to ${b.cloud?.instance ?? b.name}…`))
    : h("div", { class: "portal-msg" }, h("p", { class: "hint" }, h("span", { class: "spin" }), " Loading…")));
}

// --- render ------------------------------------------------------------------------------------------
function render() {
  const focused = document.activeElement?.id;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const v = state.view;
  let main;
  if (v.kind === "portal") {
    const b = boxByName(v.name);
    if (!b) { state.view = state.boxes[0] ? { kind: "portal", name: state.boxes[0].name } : { kind: "welcome" }; return render(); }
    // While the portal can't show (an error), the message under it must be visible.
    if (state.portalError[b.name] && state.portalShown) { state.portalShown = null; void A.portal.hide(); }
    main = h("main", { class: "main" }, toolbar(b), portalArea(b));
  } else {
    const body = v.kind === "welcome" ? welcome() : v.kind === "add" ? addPanel() : v.kind === "add-url" ? addUrlPanel()
      : v.kind === "add-gcp" ? gcpPanel(v.mode) : v.kind === "jobs" ? jobsPanel() : v.kind === "box" ? boxPanel(boxByName(v.name))
      : v.kind === "settings" ? settingsPanel() : panel(h("span", { class: "spin" }));
    main = h("main", { class: "main" }, h("div", { class: "toolbar" }, h("span", { class: "spacer" })), body);
  }
  app.replaceChildren(sidebar(), main);
  if (focused) {
    const el = document.getElementById(focused);
    if (el) { el.focus(); try { if (sel && el.setSelectionRange) el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
  }
  void syncPortal();
}

(async () => {
  state.info = await A.info();
  document.body.classList.toggle("mac", state.info.platform === "darwin");
  await refresh();
  const last = state.settings.lastBox && boxByName(state.settings.lastBox) ? state.settings.lastBox : state.boxes[0]?.name;
  state.view = last ? { kind: "portal", name: last } : { kind: "welcome" };
  render();
})();
