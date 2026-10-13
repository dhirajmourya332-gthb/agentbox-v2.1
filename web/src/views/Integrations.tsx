import { useEffect, useState } from "react";
import { api, type BenchStatus, type Integration, type SettingValue } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "../components/ui.tsx";
import { STATE_LABEL, STATE_STEP, STEP_ICON } from "../components/Setup.tsx";

/** docs/V2-ARCHITECTURE.md §10.5: the catalog, by category, with status, settings and mapped agents. */

const CATEGORIES: { id: string; label: string }[] = [
  { id: "code-hosting", label: "Code hosting" },
  { id: "cloud", label: "Cloud" },
  { id: "cluster", label: "Clusters" },
  { id: "database", label: "Databases" },
  { id: "chat", label: "Chat" },
  { id: "connectivity", label: "Connectivity" },
  { id: "extras", label: "Extras" },
];

export function useIntegrations() {
  const { onEvent } = useStore();
  const [data, setData] = useState<{ integrations: Integration[]; error: string | null } | null>(null);
  const load = () => api.integrations().then((d) => setData({ integrations: d.integrations, error: d.error })).catch((e) => setData({ integrations: [], error: e.message }));
  useEffect(() => { load(); }, []);
  useEffect(() => onEvent((e) => {
    if (e.type === "integration.updated" || e.type === "integration.mapping") load();
  }), [onEvent]);
  return { data, reload: load };
}

export function Integrations() {
  const { data, reload } = useIntegrations();
  const known = new Set(CATEGORIES.map((c) => c.id));
  const groups = [...CATEGORIES, { id: "__other", label: "Other" }]
    .map((c) => ({ ...c, items: (data?.integrations ?? []).filter((i) => (c.id === "__other" ? !known.has(i.category) : i.category === c.id)) }))
    .filter((g) => g.items.length);
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <h1>Integrations</h1>
        <p className="lede">
          The services your agents work with. The helper connects them with you: it installs what's needed and stops
          for your logins, which happen in the terminal. Each integration reaches only the agents you map to it.
        </p>
        {data?.error && <div className="error-box" style={{ marginBottom: 16 }}>Couldn't read the integration catalog: {data.error}</div>}
        {!data && <p className="hint">Loading…</p>}
        {groups.map((g) => (
          <section key={g.id}>
            <h2>{g.label}</h2>
            <div className="cards integration-cards">
              {g.items.map((it) => <IntegrationCard key={it.id} it={it} onChange={reload} />)}
            </div>
          </section>
        ))}
        {data && !data.error && groups.length === 0 && <div className="group-intro"><p>No integrations in the catalog.</p></div>}
      </div>
    </div>
  );
}

function IntegrationCard({ it, onChange }: { it: Integration; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = (v: SettingValue | null) => (v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));
  const settings = it.settings.filter((s) => shown(s.value) !== "");
  const open = async (action: "connect" | "reconnect" | "disconnect") => {
    setBusy(true); setError(null);
    try {
      const r = await api.integrationTask(it.id, action);
      location.hash = `#/helper/${r.instance_id}`;
    } catch (e: any) { setError(e.message); setBusy(false); }
  };
  const st = STATE_STEP[it.state];
  return (
    <div className={`card integration-card st-${st}${it.available ? "" : " unavailable"}`}>
      <div className="integration-top">
        <strong>{it.title}</strong>
        {it.available
          ? <span className={`int-state st-${st}`}><span className="sc-icon" aria-hidden="true">{STEP_ICON[st]}</span>{STATE_LABEL[it.state]}</span>
          : <span className="tag">Coming soon</span>}
      </div>
      {it.description && <div className="sub">{it.description}</div>}
      {(it.account || settings.length > 0) && (
        <dl className="int-settings">
          {it.account && <><dt>Account</dt><dd>{it.account}</dd></>}
          {settings.map((s) => <span key={s.key} style={{ display: "contents" }}><dt title={s.prompt}>{s.key.replace(/_/g, " ")}</dt><dd>{shown(s.value)}</dd></span>)}
        </dl>
      )}
      {!it.available && <div className="hint">Coming soon: listed so you know it's planned; it can't be connected yet.</div>}
      {it.available && it.state === "error" && it.last?.ok === false && it.last.error && <div className="hint">Last {it.last.action}: {it.last.error}</div>}
      {it.available && it.gates.length > 0 && <div className="hint">Waiting for you: {it.gates.map((g) => g.title).join("; ")}</div>}
      {it.id === "bench" && it.state !== "available" && it.state !== "disconnected" && <BenchPanel />}
      {it.available && <RoleChips it={it} onChange={onChange} />}
      {error && <div className="error-box">{error}</div>}
      {it.available && (
        <div className="int-actions">
          {(it.state === "available" || it.state === "disconnected") && (
            <button className="btn sm primary" disabled={busy} onClick={() => open("connect")}><Icon name="plug" size={14} />Connect</button>
          )}
          {it.state === "connecting" && <button className="btn sm" disabled={busy} onClick={() => open("connect")}>Continue setup</button>}
          {(it.state === "connected" || it.state === "error") && (
            <button className={`btn sm${it.state === "error" ? " primary" : ""}`} disabled={busy} onClick={() => open("reconnect")}>Reconnect</button>
          )}
          {(it.state === "connected" || it.state === "error" || it.state === "connecting") && (
            <button className="btn sm ghost danger" disabled={busy} onClick={() => open("disconnect")}>Disconnect</button>
          )}
        </div>
      )}
    </div>
  );
}

/** Device bridge: download the bridge, see what it shares right now, run the connectivity test. */
function BenchPanel() {
  const { onEvent } = useStore();
  const [st, setSt] = useState<BenchStatus | null>(null);
  const [test, setTest] = useState<{ ok: boolean; steps: { name: string; ok: boolean; detail: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.benchStatus().then(setSt).catch((e) => setError(e.message)); }, []);
  useEffect(() => onEvent((e: any) => { if (e.type === "bench.status") setSt(e.status); }), [onEvent]);
  const run = async () => {
    setBusy(true); setError(null);
    try { const r = await api.benchTest(); setTest(r); setSt(r.status); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div className="bench-panel">
      <div className="bench-line">
        <span className={`dot ${st?.connected ? "ok" : ""}`} aria-hidden="true" />
        {st?.connected
          ? <span>Bridge on <strong>{st.bridge?.host}</strong> ({st.bridge?.os}), sharing {st.devices.length} device{st.devices.length === 1 ? "" : "s"}</span>
          : <span>No bridge running: download it, run the installer on your computer, then start it.</span>}
      </div>
      {st?.connected && st.devices.length > 0 && (
        <ul className="bench-devices">
          {st.devices.map((d) => (
            <li key={d.id}><code>{d.id}</code> <span className="hint">{d.description}{d.vid ? ` · ${d.vid}:${d.pid}` : ""}</span> <code className="hint">{d.url}</code>{d.in_use && <span className="tag">in use</span>}</li>
          ))}
        </ul>
      )}
      {test && (
        <ul className="bench-test">
          {test.steps.map((s) => <li key={s.name} className={s.ok ? "ok" : "bad"}>{s.ok ? "✔" : "✖"} <strong>{s.name}</strong> <span className="hint">{s.detail}</span></li>)}
        </ul>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="int-actions">
        <a className="btn sm" href="/api/bench/install.sh" download="agentbox-bench-install.sh"><Icon name="download" size={14} />Download for your computer</a>
        <button className="btn sm" disabled={busy} onClick={run}>{busy ? "Testing…" : "Test connection"}</button>
      </div>
      <div className="hint">Then on your computer: <code>bash ~/Downloads/agentbox-bench-install.sh</code>, and to share: <code>python3 ~/.agentbox-bench/agentbox-bench.py</code> (Ctrl+C stops sharing). It dials out; nothing listens on your computer.</div>
    </div>
  );
}

/** Mapped agents as chips; the owner edits them directly. */
function RoleChips({ it, onChange }: { it: Integration; onChange: () => void }) {
  const { agents } = useStore();
  const [error, setError] = useState<string | null>(null);
  const roles = agents.filter((a) => !a.base_agent_id && !a.builtin);
  const save = async (next: string[]) => {
    setError(null);
    try { await api.setIntegrationRoles(it.id, next); onChange(); } catch (e: any) { setError(e.message); }
  };
  const unmapped = roles.filter((r) => !it.roles.includes(r.id));
  return (
    <div className="int-roles">
      <span className="hint">Used by</span>
      <div className="role-chips">
        {it.roles.map((rid) => {
          const r = agents.find((a) => a.id === rid);
          return (
            <span key={rid} className="role-chip">
              {r?.name ?? "deleted agent"}
              <button className="chip-x" aria-label={`Remove ${r?.name ?? "agent"}`} title="Remove" onClick={() => save(it.roles.filter((x) => x !== rid))}>
                <Icon name="close" size={10} />
              </button>
            </span>
          );
        })}
        {it.roles.length === 0 && <span className="hint">no agents yet</span>}
        {unmapped.length > 0 && (
          <select className="chip-add" aria-label={`Add an agent to ${it.title}`} value="" onChange={(e) => e.target.value && save([...it.roles, e.target.value])}>
            <option value="">+ Add</option>
            {unmapped.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
