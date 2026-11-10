import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { fixPath, isMac, isWin } from "./env.mjs";
import * as store from "./store.mjs";
import * as gcloud from "./gcloud.mjs";
import * as tunnels from "./tunnels.mjs";
import * as flows from "./flows.mjs";
import { bridgeEvents, bridgeStatus, findPython, initBridges, startBridge, stopAllBridges, stopBridge } from "./bridge.mjs";
import { cancelJob, getJob, jobEvents, listJobs, runJob } from "./jobs.mjs";
import { boxSession, closePortal, hidePortal, initViews, reloadPortal, resizePortal, showGuide, showPortal, shownPortal } from "./views.mjs";
import { startNotifier } from "./notify.mjs";

/**
 * The agentbox desktop app (docs/DESKTOP.md). The window is the app's own page (src/renderer), the
 * only page with the app's API (the preload). Portals load beside it in locked-down views
 * (views.mjs). The privileged parts (tunnels, the device bridge, gcloud) run here, in the main
 * process, and only on the owner's clicks in the app's own page.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, "..", "renderer", "index.html");
const ICON = path.join(here, "..", "..", "build", "icon.png");
const TRAY_ICON = path.join(here, "..", "..", "build", isMac ? "trayTemplate.png" : "tray.png");

// Trying the app without touching your real settings: AGENTBOX_DESKTOP_DATA=<dir> (and AGENTBOX_CLIENT_DIR for profiles).
if (process.env.AGENTBOX_DESKTOP_DATA) app.setPath("userData", process.env.AGENTBOX_DESKTOP_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
fixPath();

let win = null;
let tray = null;
let quitting = false;
let attentionCount = 0;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: "agentbox", show: false,
    backgroundColor: "#0e0f12", icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: isMac ? "hiddenInset" : "default", autoHideMenuBar: !isMac,
    webPreferences: { preload: path.join(here, "..", "preload", "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  initViews(win);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  // Development: AGENTBOX_DESKTOP_SNAPSHOT=<file.png> saves what the window shows after a few seconds, then quits.
  if (process.env.AGENTBOX_DESKTOP_SNAPSHOT) {
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      fs.writeFileSync(process.env.AGENTBOX_DESKTOP_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
      const portal = shownPortal();
      if (portal) fs.writeFileSync(process.env.AGENTBOX_DESKTOP_SNAPSHOT.replace(/\.png$/, "-portal.png"), (await portal.capturePage()).toPNG());
      quitting = true;
      app.quit();
    }, Number(process.env.AGENTBOX_DESKTOP_SNAPSHOT_MS ?? 3500)));
  }
  void win.loadFile(RENDERER);
  // Closing the window keeps the app (bridges, tunnels, notifications) running in the tray.
  win.on("close", (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
    if (isMac) app.dock?.hide();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (isMac) void app.dock?.show();
  win.show();
  win.focus();
}

// --- boxes, as the window sees them ----------------------------------------------------------------

const boxView = (b) => ({ ...b, bridge: bridgeStatus(b.name), tunnel: tunnels.tunnelFor(b) ? tunnels.statusOf(b.name) : null });

/** Requests to a box's portal from here: its tunnel up, its own cookies. */
function fetcherFor(box) {
  return async (url, opts) => {
    await tunnels.ensure(box);
    return boxSession(box).fetch(url, opts);
  };
}

function mustBox(name) {
  const b = store.getBox(name);
  if (!b) throw new Error(`No agentbox called ${name}`);
  return b;
}

// --- IPC: only from the app's own page ---------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || !event.senderFrame?.url.startsWith("file://")) throw new Error("Not allowed");
    return fn(...args);
  });
}

handle("app:info", () => ({ platform: process.platform, version: app.getVersion(), configDir: store.CONFIG_DIR }));

handle("boxes:list", () => store.listBoxes().map(boxView));
handle("boxes:save", (name, fields, makeDefault) => {
  const prev = store.getBox(name);
  const box = store.saveBox(name, fields, { makeDefault });
  if (prev && prev.url !== box.url) closePortal(name);
  return boxView(box);
});
handle("boxes:remove", (name) => {
  stopBridge(name);
  tunnels.close(name);
  closePortal(name);
  store.removeBox(name);
  const s = store.settings();
  delete s.bridges[name];
  store.updateSettings({ bridges: s.bridges });
  return true;
});
handle("boxes:default", (name) => { store.setDefault(name); return true; });
/** Does a portal answer at this address (and from this computer)? */
handle("boxes:test", async (url) => {
  const clean = store.cleanUrl(url);
  try {
    const r = await fetch(`${clean}/api/config/public`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) { const c = await r.json().catch(() => ({})); return { ok: true, access: c.access ?? null, host: c.host ?? null }; }
    return { ok: false, error: r.status === 401 || r.status === 403 ? "The portal answered but didn't let this computer in. In Tailscale mode this computer must be on your tailnet." : `The portal said ${r.status}` };
  } catch (e) {
    return { ok: false, error: `Nothing answered at ${clean} (${e.cause?.code ?? e.message})` };
  }
});

handle("portal:show", async (name, bounds, route) => {
  const box = mustBox(name);
  await tunnels.ensure(box);
  showPortal(box, bounds, route);
  store.updateSettings({ lastBox: name });
  return true;
});
handle("portal:resize", (bounds) => resizePortal(bounds));
handle("portal:hide", () => hidePortal());
handle("portal:reload", (name) => reloadPortal(name));
handle("portal:external", async (name) => { const b = mustBox(name); await tunnels.ensure(b); await shell.openExternal(b.url); });

handle("bridge:set", async (name, on) => {
  const box = mustBox(name);
  const s = store.settings();
  store.updateSettings({ bridges: { ...s.bridges, [name]: !!on } });
  return on ? startBridge(box, fetcherFor(box)) : stopBridge(name);
});
handle("bridge:python", async () => findPython());

handle("cloud:status", () => gcloud.status());
handle("cloud:login", () => runJob("login", "Sign in to Google Cloud", {}, async (job) => {
  job.step("Sign in in your browser (gcloud opened it)");
  const r = await gcloud.login(job.log);
  if (r.code !== 0) throw new Error(r.err.trim().split("\n").pop() || "Sign-in didn't finish");
  return gcloud.status();
}));
handle("cloud:projects", (configuration) => gcloud.projects(configuration));
handle("cloud:instances", (cloud) => gcloud.instances(cloud));
handle("cloud:defaults", () => ({ zones: gcloud.ZONES, vm: gcloud.DEFAULT_VM }));

const openGuide = (job, name, cloud) => flows.guide(job, name, cloud, (url, n) => showGuide(url, n));
handle("flow:create", (opts) => runJob("create", `Create ${opts?.name ?? "agentbox"}`, { box: opts?.name, cloud: opts?.cloud }, (job) => flows.createAgentbox(job, opts, openGuide)));
handle("flow:guide", (name, cloud) => runJob("guide", `Set up ${name}`, { box: name, cloud }, (job) => openGuide(job, name, cloud ?? mustBox(name).cloud)));
handle("flow:connect", (name, cloud) => runJob("connect", `Connect ${name}`, { box: name, cloud }, (job) => flows.connect(job, name, gcloud.checkCloud(cloud ?? mustBox(name).cloud))));
handle("flow:update", (name) => runJob("update", `Update ${name}`, { box: name }, (job) => flows.update(job, name)));

handle("jobs:list", () => listJobs());
handle("jobs:get", (id) => getJob(id));
handle("jobs:cancel", (id) => cancelJob(id));

handle("settings:get", () => store.settings());
handle("settings:set", (patch) => {
  const allowed = {};
  for (const k of ["launchAtLogin", "notify", "repoUrl"]) if (k in (patch ?? {})) allowed[k] = patch[k];
  if (typeof allowed.repoUrl === "string" && !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(allowed.repoUrl)) throw new Error("The repository is an https:// git URL");
  const next = store.updateSettings(allowed);
  if ("launchAtLogin" in allowed) setLaunchAtLogin(!!allowed.launchAtLogin);
  return next;
});

// --- launch at login: macOS / Windows through Electron, Linux through an autostart entry ------------------

function setLaunchAtLogin(on) {
  if (process.platform === "linux") {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
    const file = path.join(dir, "agentbox.desktop");
    if (on) {
      fs.mkdirSync(dir, { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=agentbox\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else fs.rmSync(file, { force: true });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"], openAsHidden: true });
}

// --- tray ---------------------------------------------------------------------------------------------

function buildTray() {
  let img = fs.existsSync(TRAY_ICON) ? nativeImage.createFromPath(TRAY_ICON) : nativeImage.createEmpty();
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip("agentbox");
  tray.on("click", () => (isWin || process.platform === "linux") && showWindow());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const boxes = store.listBoxes();
  const items = [
    { label: attentionCount ? `${attentionCount} thing${attentionCount > 1 ? "s" : ""} need you` : "Nothing needs you", enabled: false },
    { type: "separator" },
    ...boxes.flatMap((b) => [
      { label: b.name, click: () => { showWindow(); send("app:open", { name: b.name }); } },
      { label: "   Device bridge", type: "checkbox", checked: ["connected", "starting", "reconnecting", "waiting"].includes(bridgeStatus(b.name).state),
        click: (mi) => { const box = store.getBox(b.name); if (!box) return; store.updateSettings({ bridges: { ...store.settings().bridges, [b.name]: mi.checked } }); void (mi.checked ? startBridge(box, fetcherFor(box)) : stopBridge(b.name)); } },
    ]),
    { type: "separator" },
    { label: "Open agentbox", click: showWindow },
    { label: "Quit agentbox", click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setTitle?.(attentionCount ? String(attentionCount) : "");
}

// --- events to the window ------------------------------------------------------------------------------

jobEvents.on("job", (j) => send("job", j));
jobEvents.on("line", (l) => send("job:line", l));
bridgeEvents.on("bridge", (b) => { send("bridge", b); refreshTray(); });
tunnels.tunnelEvents.on("tunnel", (t) => send("tunnel", t));

// --- lifecycle -----------------------------------------------------------------------------------------

app.on("second-instance", () => showWindow());
app.on("activate", () => showWindow());
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { stopAllBridges(); tunnels.closeAll(); });
app.on("window-all-closed", () => { if (!tray) app.quit(); });

app.whenReady().then(() => {
  store.initSettings(app.getPath("userData"));
  initBridges(app.getPath("userData"));
  if (isMac) app.setAboutPanelOptions({ applicationName: "agentbox", applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    { label: "View", submenu: [{ label: "Reload portal", accelerator: "CmdOrCtrl+R", click: () => send("app:reload") }, { role: "togglefullscreen" }, { role: "toggleDevTools" }] },
    { role: "windowMenu" },
  ]));
  buildTray();
  const hidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAsHidden;
  createWindow();
  if (hidden) { win.hide(); if (isMac) app.dock?.hide(); }
  // Bridges that were on stay on across restarts.
  for (const [name, on] of Object.entries(store.settings().bridges ?? {})) {
    const box = store.getBox(name);
    if (on && box) void startBridge(box, fetcherFor(box));
  }
  startNotifier({
    boxes: () => store.listBoxes(),
    fetcherFor,
    enabled: () => store.settings().notify,
    onOpen: (name, route) => { showWindow(); send("app:open", { name, route }); },
    onCount: (n) => { attentionCount = n; refreshTray(); send("attention", n); if (isMac) app.dock?.setBadge(n ? String(n) : ""); },
  });
});
