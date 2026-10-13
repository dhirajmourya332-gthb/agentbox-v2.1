import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Icon } from "./ui.tsx";

/**
 * Ask the admin from anywhere: ⌘K / Ctrl+K (or the rail's button) opens a box; Enter starts a new admin
 * conversation with what you typed and opens it. With a conversation already open, you can add to it
 * instead.
 */
export function AskAdmin() {
  const { agents } = useStore();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const role = agents.find((a) => !a.base_agent_id && a.builtin === "setup");
  const live = role ? agents.filter((a) => a.base_agent_id === role.id && !a.retired_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : undefined;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("agentbox:ask-admin", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("agentbox:ask-admin", onOpen); };
  }, []);
  useEffect(() => { if (open) { setError(null); setTimeout(() => ref.current?.focus(), 0); } }, [open]);
  if (!open || !role) return null;

  const close = () => { if (!busy) setOpen(false); };
  const submit = async (into?: { id: string; dm_thread_id?: string | null }) => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setError(null);
    try {
      if (into?.dm_thread_id) {
        await api.send(into.dm_thread_id, v);
        go({ name: "setup", id: into.id });
      } else {
        const inst = await api.newTask(role.id, v);
        go({ name: "setup", id: inst.id });
      }
      setText(""); setOpen(false);
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };
  return (
    <div className="ask-admin-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="ask-admin" role="dialog" aria-modal="true" aria-label="Ask the admin">
        <div className="ask-admin-head">
          <strong>Ask the admin</strong>
          <span className="hint">Change an agent, add a skill, create an agent, connect something, or get work started.</span>
        </div>
        <textarea ref={ref} rows={3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
          placeholder="e.g. Make the tech-lead only orchestrate and delegate, never write code" aria-label="What do you want?" />
        {error && <div className="error-box">{error}</div>}
        <div className="ask-admin-actions">
          <button className="btn sm primary" disabled={busy || !text.trim()} onClick={() => submit()}>
            <Icon name="send" size={14} />New conversation
          </button>
          {live && (
            <button className="btn sm ghost" disabled={busy || !text.trim()} onClick={() => submit(live)} title={`Add to "${live.label ?? live.name}"`}>
              Add to “{(live.label ?? live.name).slice(0, 40)}”
            </button>
          )}
          <span className="hint" style={{ marginLeft: "auto" }}>Enter to send · Esc to close</span>
        </div>
      </div>
    </div>
  );
}

/** Open the box from a button. */
export const openAskAdmin = () => window.dispatchEvent(new Event("agentbox:ask-admin"));
