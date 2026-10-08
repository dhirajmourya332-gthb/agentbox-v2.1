import { AttachButton, AttachmentStrip, useAttachments } from "../components/Attachments.tsx";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Avatar, Icon } from "../components/ui.tsx";

/** Start a task: pick who does it, say what's needed. Every task gets its own conversation. */
export function NewTask({ roleId }: { roleId?: string }) {
  const { agents, loaded } = useStore();
  const roles = agents.filter((a) => !a.base_agent_id);
  const lead = roles.find((r) => r.can_scale);
  const [picked, setPicked] = useState<string | null>(roleId ?? null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const att = useAttachments();

  useEffect(() => {
    if (!picked && loaded) setPicked(roleId ?? lead?.id ?? roles[0]?.id ?? null);
  }, [loaded, roleId]);
  useEffect(() => ref.current?.focus(), [picked]);

  const role = roles.find((r) => r.id === picked);
  async function start() {
    if (!role || (!text.trim() && !att.paths.length) || att.uploading) return;
    setBusy(true);
    setError(null);
    try {
      const inst = await api.newTask(role.id, text.trim(), title.trim() || undefined, att.paths);
      att.clear();
      go({ name: "agent", id: inst.id });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); }
  };

  if (!loaded) return <div className="page" />;
  if (!roles.length) {
    return (
      <div className="page"><div className="page-inner" style={{ maxWidth: 680 }}>
        <h1>New task</h1>
        <p className="lede">You don't have any agents yet. <a href="#/agents/new">Create your first agent</a>.</p>
      </div></div>
    );
  }
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1>New task</h1>
          <p className="lede" style={{ marginBottom: 0 }}>Each task gets its own conversation, so work never gets mixed up.</p>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}

        <div className="field">
          <span style={{ fontWeight: 500 }} id="nt-who">Who should do it?</span>
          <div className="who-grid" role="radiogroup" aria-labelledby="nt-who">
            {roles.map((r) => (
              <button key={r.id} className="who-card" role="radio" aria-checked={picked === r.id} onClick={() => setPicked(r.id)}>
                <Avatar name={r.name} color={r.color} size={28} />
                <span className="who-text">
                  <strong>{r.name}</strong>
                  <span className="hint">{r.title}</span>
                </span>
                {r.can_scale ? <span className="who-tag">Plans and delegates</span> : null}
                {agents.some((a) => a.base_agent_id === r.id) && (
                  <span className="hint who-live">{agents.filter((a) => a.base_agent_id === r.id).length} live task(s)</span>
                )}
              </button>
            ))}
          </div>
          {lead && picked !== lead.id && (
            <span className="hint">Anything with several steps or people? Give it to <button className="link-button" onClick={() => setPicked(lead.id)}>{lead.name}</button>; it splits the work and hands it out.</span>
          )}
        </div>

        <div className={`field drop-zone${att.dragging ? " dropping" : ""}`} {...att.dropProps}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <label htmlFor="nt-text">What needs doing?</label>
            <AttachButton a={att} />
          </div>
          <textarea id="nt-text" ref={ref} className="text" rows={7} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={att.onPaste}
            placeholder={role?.can_scale ? "e.g. Plan and build API-key access for the MSP portal. Ask me before filing the epic." : "e.g. Fix Dependabot alert #3232 in scrutex-guard/console."} />
          <AttachmentStrip a={att} />
          <span className="hint">{att.uploading ? "Uploading image…" : "Paste (⌘V), drop or attach screenshots; the agent can open them."}</span>
        </div>
        <div className="field">
          <label htmlFor="nt-title">Title <span className="hint">(optional; defaults to the first line)</span></label>
          <input id="nt-title" className="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="MSP API keys" />
        </div>

        <div className="wizard-nav">
          <a className="btn ghost" href="#/">Cancel</a>
          <span className="grow" />
          <span className="hint">⌘⏎ to start</span>
          <button className="btn primary" disabled={!role || (!text.trim() && !att.paths.length) || att.uploading || busy} onClick={start}>
            {busy ? "Starting…" : `Start${role ? ` with ${role.name}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
