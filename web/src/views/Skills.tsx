import { useEffect, useState } from "react";
import { api, type Agent, type Skill, type SkillDraft } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Avatar, Icon, Markdown, relTime } from "../components/ui.tsx";

/** Pick which agents get a skill. Used by the editor and draft review. */
export function AgentPicker({ agents: all, value, onChange }: { agents: Agent[]; value: string[]; onChange: (ids: string[]) => void }) {
  const agents = all.filter((a) => !a.base_agent_id);
  if (agents.length === 0) return <span className="hint">No agents yet.</span>;
  return (
    <div className="choices" role="group" aria-label="Agents">
      {agents.map((a) => {
        const on = value.includes(a.id);
        return (
          <button key={a.id} className="pill" aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== a.id) : [...value, a.id])}>
            <Avatar name={a.name} color={a.color} size={18} />
            {a.name}
            {on && <Icon name="check" size={14} />}
          </button>
        );
      })}
    </div>
  );
}

function AgentStack({ ids, agents }: { ids: string[]; agents: Agent[] }) {
  const list = ids.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as Agent[];
  if (!list.length) return <span className="hint">Not assigned</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title={list.map((a) => a.name).join(", ")}>
      {list.map((a) => <Avatar key={a.id} name={a.name} color={a.color} size={20} />)}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function SkillsList() {
  const { skills, drafts, agents, loaded } = useStore();
  if (!loaded) return <div className="page" />;
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "a deleted agent";
  return (
    <div className="page">
      <div className="page-inner">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1>Skills</h1>
            <p className="lede">
              Reusable procedures agents follow: how to file an issue, review a PR, deploy. An agent only sees the skills
              assigned to it, and uses one when the task matches its description.
            </p>
          </div>
          <a className="btn primary" href="#/skills/new"><Icon name="plus" />New skill</a>
        </div>

        {drafts.length > 0 && (
          <>
            <h2>Proposed by agents · waiting for you</h2>
            <div className="rows">
              {drafts.map((d) => (
                <a key={d.id} className="row skill-row" href={`#/skills/drafts/${d.id}`}>
                  <span className="dot warn" />
                  <span className="name mono">{d.name}</span>
                  <span className="desc">{d.description}</span>
                  <span className="hint" style={{ whiteSpace: "nowrap" }}>{nameOf(d.proposed_by)} · {relTime(d.created_at)}</span>
                </a>
              ))}
            </div>
          </>
        )}

        <h2>Library</h2>
        {skills.length === 0 ? (
          <p className="hint">No skills yet. Create one, or ask an agent to propose one after it finishes a task.</p>
        ) : (
          <div className="rows">
            {skills.map((s) => (
              <a key={s.name} className="row skill-row" href={`#/skills/${s.name}`}>
                <Icon name="skill" />
                <span className="name mono">{s.name}</span>
                <span className="desc">{s.description}</span>
                <AgentStack ids={s.agents} agents={agents} />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function BodyEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  return (
    <div className="field">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <label htmlFor="sk-body" style={{ marginRight: "auto" }}>Instructions</label>
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>Edit</button>
          <button aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
        </div>
      </div>
      {mode === "edit" ? (
        <textarea id="sk-body" className="text mono" rows={22} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div className="preview-box"><Markdown text={value || "_Nothing yet._"} /></div>
      )}
      <span className="hint">Steps, commands and checks, written for an agent. Keep it general so it applies to every similar task.</span>
    </div>
  );
}

const NEW_TEMPLATE = `# <What this skill does>

## When to use
-

## Steps
1.

## Check before you report done
-
`;

export function SkillEditor({ name }: { name?: string }) {
  const { agents } = useStore();
  const creating = !name;
  const [skill, setSkill] = useState<Skill | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: NEW_TEMPLATE, agents: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!name) return;
    api.skill(name).then((s) => {
      setSkill(s);
      setForm({ name: s.name, description: s.description, body: s.body, agents: s.agents });
    }).catch((e) => setError(e.message));
  }, [name]);

  async function save() {
    setError(null);
    try {
      if (creating) {
        const s = await api.createSkill(form);
        go({ name: "skill", skill: s.name });
      } else {
        setSkill(await api.updateSkill(name!, form));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (!creating && !skill && !error) return <div className="page" />;
  return (
    <div className="page">
      <div className="page-inner" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <a className="btn ghost sm" href="#/skills" style={{ marginLeft: -10 }}><Icon name="back" />Skills</a>
          <h1 style={{ marginTop: 8 }}>{creating ? "New skill" : <span className="mono" style={{ fontSize: 22 }}>{name}</span>}</h1>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}

        {creating && (
          <div className="field">
            <label htmlFor="sk-name">Name</label>
            <input id="sk-name" className="text mono" value={form.name} placeholder="deploy-staging"
              onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
            <span className="hint">Lowercase with dashes. It can't be changed later.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="sk-desc">When to use it</label>
          <input id="sk-desc" className="text" value={form.description}
            placeholder="Deploy a merged change to staging and verify it. Use after a PR merges to main."
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <span className="hint">Agents decide whether to use the skill from this sentence alone. Say what it does and when.</span>
        </div>
        <BodyEditor value={form.body} onChange={(body) => setForm({ ...form, body })} />
        {skill && skill.files.length > 0 && (
          <div className="field">
            <span style={{ fontWeight: 500 }}>Files</span>
            <div className="rows">
              {skill.files.map((f) => <div key={f} className="row"><span className="val">/skills/{skill.name}/{f}</span></div>)}
            </div>
            <span className="hint">Scripts the instructions refer to. Agents (or you, in the Terminal) edit them in place.</span>
          </div>
        )}
        <div className="field">
          <span style={{ fontWeight: 500 }}>Assigned to</span>
          <AgentPicker agents={agents} value={form.agents} onChange={(ids) => setForm({ ...form, agents: ids })} />
        </div>

        <div className="wizard-nav">
          {!creating && (confirmDelete ? (
            <>
              <button className="btn danger" onClick={async () => {
                try { await api.deleteSkill(name!); go({ name: "skills" }); } catch (e: any) { setError(e.message); }
              }}>Delete {name}</button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Delete…</button>
          ))}
          <span className="grow" />
          {saved && <span className="hint" role="status">Saved</span>}
          <button className="btn primary" onClick={save}>{creating ? "Create skill" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DraftReview({ id }: { id: string }) {
  const { agents } = useStore();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [existing, setExisting] = useState<Skill | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: "", agents: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.skillDraft(id).then(({ draft, existing }) => {
      setDraft(draft);
      setExisting(existing);
      setForm({
        name: draft.name, description: draft.description, body: draft.body,
        agents: [...new Set([draft.proposed_by, ...(existing?.agents ?? [])])].filter((a) => agents.some((x) => x.id === a)),
      });
    }).catch((e) => setError(e.message));
  }, [id]);

  const proposer = agents.find((a) => a.id === draft?.proposed_by);

  async function act(kind: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "approve") await api.approveDraft(id, form);
      else await api.rejectDraft(id);
      go(kind === "approve" ? { name: "skill", skill: form.name } : { name: "skills" });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (!draft) return <div className="page"><div className="page-inner">{error && <div className="error-box">{error}</div>}</div></div>;
  return (
    <div className="page">
      <div className="page-inner" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <a className="btn ghost sm" href="#/skills" style={{ marginLeft: -10 }}><Icon name="back" />Skills</a>
          <div className="stage" style={{ marginTop: 8 }}>Proposed skill{draft.status !== "pending" && ` · ${draft.status}`}</div>
          <h1 className="mono" style={{ fontSize: 22, marginTop: 4 }}>{draft.name}</h1>
          <p className="lede" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
            {proposer && <Avatar name={proposer.name} color={proposer.color} size={20} />}
            {proposer?.name ?? "An agent"} proposed this {relTime(draft.created_at)}
            {proposer && <> · <a href={`#/agents/${proposer.id}`}>open chat</a></>}
          </p>
        </div>
        {existing && (
          <div className="error-box" style={{ color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 45%, var(--line))" }}>
            A skill called <span className="mono">{existing.name}</span> already exists. Approving replaces its instructions.{" "}
            <a href={`#/skills/${existing.name}`}>See the current version</a>.
          </div>
        )}
        {error && <div className="error-box" role="alert">{error}</div>}

        <div className="field">
          <label htmlFor="dr-name">Name</label>
          <input id="dr-name" className="text mono" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
        </div>
        <div className="field">
          <label htmlFor="dr-desc">When to use it</label>
          <input id="dr-desc" className="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <BodyEditor value={form.body} onChange={(body) => setForm({ ...form, body })} />
        <div className="field">
          <span style={{ fontWeight: 500 }}>Assign to</span>
          <AgentPicker agents={agents} value={form.agents} onChange={(ids) => setForm({ ...form, agents: ids })} />
        </div>

        {draft.status === "pending" && (
          <div className="wizard-nav">
            <button className="btn ghost danger" disabled={busy} onClick={() => act("reject")}>Reject</button>
            <span className="grow" />
            <button className="btn primary" disabled={busy} onClick={() => act("approve")}>Approve and add to library</button>
          </div>
        )}
      </div>
    </div>
  );
}
