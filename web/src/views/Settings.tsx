import { useEffect, useState } from "react";
import { api, type Settings as SettingsData } from "../api.ts";

/**
 * The owner's settings (server/src/settings.ts). For now, how many tasks may be live at once: the
 * New task page links here when that limit is reached.
 */
export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.settings().then((d) => { setS(d); setLimit(String(d.max_live_tasks)); }, (e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const n = Number(limit);
  const valid = !!s && Number.isInteger(n) && n >= s.min_live_tasks && n <= s.limit_live_tasks;
  const changed = !!s && valid && n !== s.max_live_tasks;

  async function save() {
    if (!changed) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const d = await api.saveSettings({ max_live_tasks: n });
      setS(d);
      setLimit(String(d.max_live_tasks));
      setSaved(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1>Settings</h1>
          <p className="lede" style={{ marginBottom: 0 }}>How this agentbox runs.</p>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}

        <div className="field">
          <label htmlFor="s-live" style={{ fontWeight: 500 }}>Live tasks at once</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input id="s-live" className="text" type="number" inputMode="numeric" style={{ width: 120 }}
              min={s?.min_live_tasks} max={s?.limit_live_tasks} value={limit}
              onChange={(e) => { setLimit(e.target.value); setSaved(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} disabled={!s} />
            <button className="btn primary" onClick={save} disabled={!changed || busy}>{busy ? "Saving…" : "Save"}</button>
            {saved && <span className="hint" role="status">Saved. It applies to the next task.</span>}
          </div>
          {s && (
            <span className="hint">
              {s.live_tasks} live now. Every task that hasn't been finished counts, including helpers an agent started, routines and groups.
              A waiting task costs nothing but its folder (and repo checkouts) on disk: Claude only runs while a task takes a turn, and at
              most 6 turns run at once (the rest queue), whatever this limit is. Default {s.default_max_live_tasks}; from {s.min_live_tasks} to {s.limit_live_tasks}.
              {!valid && limit !== "" ? ` Enter a whole number from ${s.min_live_tasks} to ${s.limit_live_tasks}.` : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
