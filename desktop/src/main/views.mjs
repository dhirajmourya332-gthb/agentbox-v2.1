import { BrowserWindow, WebContentsView, session, shell } from "electron";

/**
 * The portals, shown inside the app. A portal is the agentbox's own web page, so it gets NOTHING of
 * the app's privileges: no preload, no Node, sandboxed, its own cookie jar per agentbox, and it can't
 * navigate away from its own address (other links open in the default browser). Microphone and
 * clipboard are allowed (voice input, Copy buttons); everything else is refused.
 */

const ALLOWED_PERMISSIONS = new Set(["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen", "notifications"]);

export const partitionOf = (name) => `persist:box-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;

function lockDown(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    try { if (new URL(url).origin === origin) return; } catch { /* not a URL */ }
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  contents.on("will-attach-webview", (e) => e.preventDefault());
}

const prepared = new Set();
function prepareSession(partition, origin) {
  const ses = session.fromPartition(partition);
  if (prepared.has(partition)) return ses;
  prepared.add(partition);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    let from = "";
    try { from = new URL(details.requestingUrl ?? wc.getURL()).origin; } catch { /* none */ }
    cb(from === origin && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => requestingOrigin === origin && ALLOWED_PERMISSIONS.has(permission));
  return ses;
}

/** The session a box's portal uses (the app's requests to it, e.g. the bridge's, carry the same cookies). */
export function boxSession(box) {
  return prepareSession(partitionOf(box.name), new URL(box.url).origin);
}

const views = new Map(); // name → { view, url }
let host = null;
let shown = null;

export function initViews(win) { host = win; }

export function showPortal(box, bounds, route) {
  const origin = new URL(box.url).origin;
  let v = views.get(box.name);
  if (v && v.url !== box.url) { closePortal(box.name); v = null; }
  if (!v) {
    boxSession(box);
    const view = new WebContentsView({
      webPreferences: { partition: partitionOf(box.name), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: true },
    });
    lockDown(view.webContents, origin);
    view.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3) host?.webContents.send("portal:error", { name: box.name, error: `${desc} (${url})` });
    });
    view.webContents.on("did-finish-load", () => host?.webContents.send("portal:loaded", { name: box.name }));
    void view.webContents.loadURL(box.url + "/" + (route ?? ""));
    v = { view, url: box.url };
    views.set(box.name, v);
  } else if (route) {
    void v.view.webContents.loadURL(box.url + "/" + route);
  }
  if (shown && shown !== box.name) { const old = views.get(shown); if (old) host.contentView.removeChildView(old.view); }
  host.contentView.addChildView(v.view);
  v.view.setBounds(roundBounds(bounds));
  shown = box.name;
}

const roundBounds = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });

export function resizePortal(bounds) {
  if (!shown) return;
  views.get(shown)?.view.setBounds(roundBounds(bounds));
}

export function hidePortal() {
  if (!shown) return;
  const v = views.get(shown);
  if (v) host.contentView.removeChildView(v.view);
  shown = null;
}

/** The portal on screen now (the development snapshot captures it too). */
export const shownPortal = () => (shown ? views.get(shown)?.view.webContents ?? null : null);

export function reloadPortal(name) { views.get(name)?.view.webContents.reload(); }

export function closePortal(name) {
  const v = views.get(name);
  if (!v) return;
  if (shown === name) hidePortal();
  v.view.webContents.close();
  views.delete(name);
}

/** The setup guide (a one-time link on localhost through an IAP tunnel), in its own window. */
export function showGuide(url, name) {
  const origin = new URL(url).origin;
  const partition = `guide-${Date.now()}`; // fresh each time: the link is one-time anyway
  prepareSession(partition, origin);
  const win = new BrowserWindow({
    width: 1400, height: 900, title: `Set up ${name}`, autoHideMenuBar: true,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  lockDown(win.webContents, origin);
  void win.loadURL(url);
  return win;
}
