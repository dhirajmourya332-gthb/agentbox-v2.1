import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "./ui.tsx";

export type VmAlert = { id: string; level: "warn" | "critical"; title: string; detail: string };
export type VmDisk = { mount: string; paths: string[]; total: number; free: number; used_pct: number; inodes_used_pct: number | null };
export type VmMemory = { total: number; available: number; used_pct: number; swap_total: number; swap_free: number };

/**
 * One health poll shared by everything that shows it (the VM chip, the warning bar), every 15 s while
 * anything is mounted. `error` is set when the check itself failed.
 */
type HealthState = { health: any | null; error: boolean };
let state: HealthState = { health: null, error: false };
const listeners = new Set<(s: HealthState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function poll() {
  api.health()
    .then((h) => set({ health: h, error: false }))
    .catch(() => set({ health: state.health, error: true }));
}
function set(next: HealthState) {
  state = next;
  listeners.forEach((l) => l(state));
}

export function useHealth(): HealthState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!timer) { poll(); timer = setInterval(poll, 15000); }
    return () => {
      listeners.delete(setS);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return s;
}

export function VmChip() {
  const { connected } = useStore();
  const { health, error } = useHealth();
  const down = health ? Object.values(health.services).filter((s) => s !== "active").length + (health.browser.ok ? 0 : 1) : 0;
  const alerts: VmAlert[] = health?.resources?.alerts ?? [];
  const critical = alerts.some((a) => a.level === "critical");
  const issues = down + alerts.length;
  const bad = !connected || error || critical;
  const warn = !bad && issues > 0;
  const label = !connected || error ? "VM unreachable"
    : !health ? "VM…"
    : critical ? (alerts.find((a) => a.level === "critical")!.id.startsWith("disk") ? "VM disk full" : "VM low memory")
    : warn ? `VM ${issues} issue${issues > 1 ? "s" : ""}` : "VM ok";
  return (
    <a className={`chip ${bad ? "bad" : warn ? "warn" : ""}`} href="#/system" style={{ textDecoration: "none" }}
      title={alerts.map((a) => a.title).join("\n") || undefined}>
      <span className={`dot ${bad ? "bad" : warn ? "warn" : "ok"}`} />
      {label}
    </a>
  );
}

/**
 * A dismissed warning stays hidden at its level, in this browser. It shows again when it gets worse
 * (warn → critical), or when it clears and later comes back.
 */
const DISMISSED_KEY = "agentbox.vm.dismissed";
function readDismissed(): string[] {
  try { const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeDismissed(keys: string[]) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys)); } catch { /* storage unavailable */ }
}
const keyOf = (a: VmAlert) => `${a.id}|${a.level}`;

export function VmAlertBar() {
  const { health } = useHealth();
  const [dismissed, setDismissed] = useState(readDismissed);
  const alerts: VmAlert[] | null = health?.resources?.alerts ?? null;
  // Forget dismissals of warnings that have cleared, so a recurrence is shown again.
  useEffect(() => {
    if (!alerts) return;
    const live = new Set(alerts.map(keyOf));
    const kept = dismissed.filter((k) => live.has(k));
    if (kept.length !== dismissed.length) { setDismissed(kept); writeDismissed(kept); }
  }, [alerts, dismissed]);
  const shown = (alerts ?? []).filter((a) => !dismissed.includes(keyOf(a)));
  if (!shown.length) return null;
  const dismiss = (a: VmAlert) => {
    const next = [...dismissed, keyOf(a)];
    setDismissed(next);
    writeDismissed(next);
  };
  return (
    <>
      {shown.map((a) => (
        <div key={a.id} className={`paused-bar global vm-alert ${a.level}`} role={a.level === "critical" ? "alert" : "status"}>
          <Icon name="alert" size={14} />
          <span className="vm-alert-text"><strong>{a.title}.</strong> {a.detail}</span>
          <a className="btn sm" href="#/system">Details</a>
          <button className="icon-btn" aria-label="Dismiss" title="Dismiss (shows again if it gets worse)" onClick={() => dismiss(a)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </>
  );
}
