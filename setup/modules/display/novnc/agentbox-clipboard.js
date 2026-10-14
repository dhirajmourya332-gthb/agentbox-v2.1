// agentbox (setup/modules/display): the owner's clipboard <-> the shared screen, loaded by the portal's
// noVNC page (vnc.html, built by install.sh). Text only.
//   Paste: ⌘V (Ctrl+V elsewhere) sends the local clipboard's text to the VM's clipboard, then
//          presses Ctrl+V there. A paste the owner triggers may read the clipboard: no prompt.
//   Mac:   ⌘ acts as Ctrl in the VM (⌘C, ⌘X, ⌘A, ⌘Z… do what they do on the Mac).
//   Copy:  text copied in the VM lands on the local clipboard, after a copy the owner made here (⌘C / Ctrl+C /
//          ⌘X, or a right-click menu). x11vnc also sends plain selections (PRIMARY), and its -noprimary
//          stops CLIPBOARD updates too, so selections are filtered out here instead.
import UI from "./app/ui.js";

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const XK_Control_L = 0xffe3, XK_v = 0x0076;

let rfb = null, connectedAt = 0, ctrlSent = false, pasteWait = null, copyKeyAt = 0, menuAt = 0;

// UI.rfb is replaced on every (re)connect.
function current() {
  if (UI.rfb !== rfb) {
    rfb = UI.rfb;
    connectedAt = Date.now();
    if (rfb) rfb.addEventListener("clipboard", (e) => copyOut(e.detail.text));
  }
  return rfb;
}
setInterval(current, 500);

// A hidden field takes the browser's paste where a canvas doesn't receive one.
const sink = document.createElement("textarea");
sink.setAttribute("aria-hidden", "true");
sink.tabIndex = -1;
sink.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
document.addEventListener("DOMContentLoaded", () => document.body.appendChild(sink));

function ctrl(down) {
  const r = current();
  if (!r || ctrlSent === down) return;
  ctrlSent = down;
  r.sendKey(XK_Control_L, "ControlLeft", down);
}

function pasteIn(text) {
  const r = current();
  if (!r) return;
  if (text) r.clipboardPasteFrom(text);
  // Let the VM take the new clipboard before the keystroke that pastes it. A Ctrl the owner holds was
  // released when the canvas lost focus, so press it here (unless it's our own ⌘-as-Ctrl, still down).
  setTimeout(() => {
    if (!ctrlSent) r.sendKey(XK_Control_L, "ControlLeft", true);
    r.sendKey(XK_v, "KeyV");
    if (!ctrlSent) r.sendKey(XK_Control_L, "ControlLeft", false);
  }, 60);
}

function finishPaste(text) {
  if (!pasteWait) return;
  clearTimeout(pasteWait.timer);
  const { focus } = pasteWait;
  pasteWait = null;
  pasteIn(text);
  focus?.focus({ preventScroll: true });
}

// Chrome delivers the paste to the focused canvas, Safari/Firefox to the sink: take it wherever it lands.
window.addEventListener("paste", (e) => {
  const r = current();
  if (!r || r.viewOnly || !(pasteWait || e.target === sink || r._canvas?.contains?.(e.target))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const text = e.clipboardData?.getData("text/plain") || "";
  if (pasteWait) finishPaste(text);
  else pasteIn(text);
}, true);

function copyOut(text) {
  // The VM's clipboard as it stood when we connected isn't news; and only a focused page may write.
  const now = Date.now();
  if (now - connectedAt < 1500 || !document.hasFocus() || !text) return;
  if (now - copyKeyAt > 5000 && now - menuAt > 30000) return;  // a selection, not a copy
  copyKeyAt = menuAt = 0;
  navigator.clipboard?.writeText(text).catch(() => {});
}

const isMeta = (e) => e.code === "MetaLeft" || e.code === "MetaRight" || e.key === "Meta";

window.addEventListener("keydown", (e) => {
  const r = current();
  if (!r || r.viewOnly || e.target === sink) return;
  if (MAC && isMeta(e)) {
    e.stopImmediatePropagation();
    ctrl(true);
    return;
  }
  if ((e.code === "KeyC" || e.code === "KeyX") && (MAC ? e.metaKey : e.ctrlKey)) copyKeyAt = Date.now();
  if (e.code === "KeyV" && (MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
    // Keep the key from noVNC and let the browser paste into the sink.
    e.stopImmediatePropagation();
    pasteWait = {
      focus: document.activeElement,
      // No paste event (some browsers, or nothing to paste): ask the Clipboard API, else paste what the VM has.
      timer: setTimeout(() => {
        navigator.clipboard?.readText ? navigator.clipboard.readText().then(finishPaste, () => finishPaste("")) : finishPaste("");
      }, 300),
    };
    sink.value = "";
    sink.focus({ preventScroll: true });
  }
}, true);

window.addEventListener("keyup", (e) => {
  if (MAC && isMeta(e)) {
    e.stopImmediatePropagation();
    ctrl(false);
  }
}, true);

window.addEventListener("mousedown", (e) => { if (e.button === 2) menuAt = Date.now(); }, true);

window.addEventListener("blur", () => ctrl(false));
