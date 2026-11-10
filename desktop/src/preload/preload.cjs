// The app's own page only (src/renderer): a fixed list of calls into the main process. Portals get no preload.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(["job", "job:line", "bridge", "tunnel", "attention", "app:open", "app:reload", "portal:error", "portal:loaded"]);

contextBridge.exposeInMainWorld("agentbox", {
  info: call("app:info"),
  boxes: { list: call("boxes:list"), save: call("boxes:save"), remove: call("boxes:remove"), setDefault: call("boxes:default"), test: call("boxes:test") },
  portal: { show: call("portal:show"), resize: call("portal:resize"), hide: call("portal:hide"), reload: call("portal:reload"), external: call("portal:external") },
  bridge: { set: call("bridge:set"), python: call("bridge:python") },
  cloud: { status: call("cloud:status"), login: call("cloud:login"), projects: call("cloud:projects"), instances: call("cloud:instances"), defaults: call("cloud:defaults") },
  flow: { create: call("flow:create"), guide: call("flow:guide"), connect: call("flow:connect"), update: call("flow:update") },
  jobs: { list: call("jobs:list"), get: call("jobs:get"), cancel: call("jobs:cancel") },
  settings: { get: call("settings:get"), set: call("settings:set") },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`unknown event ${channel}`);
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
