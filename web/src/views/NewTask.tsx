import { AttachButton, AttachmentStrip, useAttachments } from "../components/Attachments.tsx";
import { MicButton, VoiceStatus, useVoice } from "../components/Voice.tsx";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type Repo } from "../api.ts";
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
  const [repos, setRepos] = useState<Repo[]>([]);
  const [pickedRepos, setPickedRepos] = useState<string[]>([]);
  const [planFirst, setPlanFirst] = useState(false);
  useEffect(() => { api.repos().then((d) => setRepos(d.repos.filter((r) => r.status === "ready"))).catch(() => setRepos([])); }, []);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const att = useAttachments();
  const voice = useVoice({ input: ref, text, setText, purpose: "task", agentId: picked ?? undefined });

  useEffect(() => {
    if (!picked && loaded) setPicked(roleId ?? lead?.id ?? roles[0]?.id ?? null);
  }, [loaded, roleId]);
  useEffect(() => ref.current?.focus(), [picked]);

  const role = roles.find((r) => r.id === picked);
  // Only repos the picked agent may use (allowed_roles empty = every agent); never for the setup agent.
  const usable = role && !role.builtin ? repos.filter((r) => r.allowed_roles.length === 0 || r.allowed_roles.includes(role.id)) : [];
  const chosenRepos = pickedRepos.filter((n) => usable.some((r) => r.name === n));
  async function start() {
    if (!role || (!text.trim() && !att.paths.length) || att.uploading) return;
    setBusy(true);
    setError(null);
    try {
      const inst = await api.newTask(role.id, text.trim(), title.trim() || undefined, att.paths, chosenRepos.length ? chosenRepos : undefined, planFirst && !role.builtin);
      att.clear();
      // The setup agent works in its own workspace (chat, terminal and checklist on one screen).
      go(role.builtin === "setup" ? { name: "setup", id: inst.id } : { name: "agent", id: inst.id });
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
            <span style={{ display: "flex", gap: 4 }}>
              <AttachButton a={att} />
              <MicButton v={voice} />
            </span>
          </div>
          <textarea id="nt-text" ref={ref} className="text" rows={7} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={att.onPaste}
            placeholder={role?.can_scale ? "e.g. Plan and build API-key access for the partner portal. Ask me before filing the epic." : "e.g. Fix Dependabot alert #1234 in acme/web-app."} />
          <VoiceStatus v={voice} />
          <AttachmentStrip a={att} />
          <span className="hint">{att.uploading ? "Uploading image…" : role?.builtin === "setup"
            ? "It opens in the Setup workspace: your terminal, the chat and a checklist on one screen. Never paste tokens or passwords here."
            : "Paste (⌘V), drop or attach screenshots; the agent can open them."}</span>
        </div>
        {usable.length > 0 && (
          <div className="field">
            <span style={{ fontWeight: 500 }} id="nt-repos">Repos <span className="hint">(optional; each gets its own worktree and branch for this task)</span></span>
            <div className="choices" role="group" aria-labelledby="nt-repos">
              {usable.map((r) => (
                <button key={r.id} className="pill" aria-pressed={chosenRepos.includes(r.name)} title={r.description || r.url}
                  onClick={() => setPickedRepos(chosenRepos.includes(r.name) ? chosenRepos.filter((x) => x !== r.name) : [...chosenRepos, r.name])}>
                  <Icon name="repo" size={12} /> {r.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {role && !role.builtin && (
          <label className="field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={planFirst} style={{ marginTop: 3 }} onChange={(e) => setPlanFirst(e.target.checked)} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Approve a plan first</span>
              <span className="hint">Before changing anything, {role.name} shows you a simple before/after diagram of what it'll change. Edits and commits wait for your OK.</span>
            </span>
          </label>
        )}
        <div className="field">
          <label htmlFor="nt-title">Title <span className="hint">(optional; defaults to the first line)</span></label>
          <input id="nt-title" className="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Partner API keys" />
        </div>

        <div className="wizard-nav">
          <a className="btn ghost" href="#/">Cancel</a>
          <span className="grow" />
          <span className="hint">⌘⏎ to start</span>
          <button className="btn primary" disabled={!role || (!text.trim() && !att.paths.length) || att.uploading || busy} onClick={start}>
            {busy ? "Starting…" : role?.builtin === "setup" ? "Start with setup" : `Start${role ? ` with ${role.name}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
