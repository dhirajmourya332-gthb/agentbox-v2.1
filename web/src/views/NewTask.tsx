import { AttachButton, AttachmentStrip, useAttachments } from "../components/Attachments.tsx";
import { MicButton, VoiceStatus, useVoice } from "../components/Voice.tsx";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type Repo } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Avatar, Icon } from "../components/ui.tsx";
import { crewLead } from "./Crews.tsx";

const LAST_CREW = "agentbox.newtask.crew";

/**
 * Start a task: pick the crew, then who in it does it (the crew's lead by default), and say what's
 * needed. Every task gets its own conversation. `#/new/crew:<id>` opens on a crew; `#/new/<role>` on an agent.
 */
export function NewTask({ roleId: param }: { roleId?: string }) {
  const { agents, crews, loaded } = useStore();
  const crewParam = param?.startsWith("crew:") ? param.slice(5) : undefined;
  const roleId = crewParam ? undefined : param;
  // The setup agent starts from Configure → Setup (its own workspace), not here.
  const allRoles = agents.filter((a) => !a.base_agent_id && !a.builtin);
  const setupLink = roleId && agents.some((a) => a.id === roleId && a.builtin === "setup");
  useEffect(() => { if (setupLink) location.replace("#/helper"); }, [setupLink]);
  // Crews: "" is the agents in no crew (a crew of their own); only offered when it has agents.
  const crewOf = (r: { crew_id?: string | null }) => (r.crew_id && crews.some((c) => c.id === r.crew_id) ? r.crew_id : "");
  const crewChoices = [...crews.map((c) => ({ id: c.id, name: c.name, summary: c.summary })),
    ...(allRoles.some((r) => !crewOf(r)) ? [{ id: "", name: "No crew", summary: "" }] : [])];
  const [crew, setCrew] = useState<string | null>(null);
  const roles = crews.length && crew !== null ? allRoles.filter((r) => crewOf(r) === crew) : allRoles;
  const lead = crews.length ? crewLead(crew || null, allRoles.filter((r) => crewOf(r) === (crew ?? "")), crews) : allRoles.find((r) => r.can_scale);
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

  // The crew to open on: the one asked for, the asked-for agent's, else the last one used.
  useEffect(() => {
    if (!loaded || crew !== null) return;
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_CREW); } catch { /* fine without it */ }
    const asked = roleId ? allRoles.find((r) => r.id === roleId) : undefined;
    const start = crewParam !== undefined && crewChoices.some((c) => c.id === crewParam) ? crewParam
      : asked ? crewOf(asked)
      : last !== null && crewChoices.some((c) => c.id === last) ? last
      : crewChoices[0]?.id ?? "";
    setCrew(start);
  }, [loaded, crews.length]);
  const chooseCrew = (id: string) => {
    setCrew(id);
    const l = crewLead(id || null, allRoles.filter((r) => crewOf(r) === id), crews);
    setPicked(l?.id ?? null);
  };
  useEffect(() => {
    if (!loaded || crew === null) return;
    if (!picked || !roles.some((r) => r.id === picked)) setPicked(roleId && roles.some((r) => r.id === roleId) ? roleId : lead?.id ?? roles[0]?.id ?? null);
  }, [loaded, crew]);
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
      if (crews.length && crew !== null) { try { localStorage.setItem(LAST_CREW, crew); } catch { /* fine without it */ } }
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
  if (!allRoles.length) {
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

        {crews.length > 0 && (
          <div className="field">
            <span style={{ fontWeight: 500 }} id="nt-crew">Which crew?</span>
            <div className="choices" role="radiogroup" aria-labelledby="nt-crew">
              {crewChoices.map((c) => (
                <button key={c.id || "none"} className="pill" role="radio" aria-checked={crew === c.id} aria-pressed={crew === c.id}
                  title={c.summary || undefined} onClick={() => chooseCrew(c.id)}>
                  {c.name}
                </button>
              ))}
              <a className="hint" href="#/crews" style={{ alignSelf: "center", marginLeft: 4 }}>Manage crews</a>
            </div>
            <span className="hint">Each crew is a separate team: its agents only hand work to each other.</span>
          </div>
        )}

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
          {roles.length === 0 && <span className="hint">No agents in this crew yet. <a href="#/crews">Move some in</a> or <a href="#/agents/new">create one</a>.</span>}
          {lead && lead.can_scale && picked !== lead.id && (
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
