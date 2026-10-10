/**
 * Profile toggles: pure, shared by the guide server and the page (no Node imports here).
 */
export type Dep = { id: string; depends: string[] };
export const REQUIRED_IDS = ["core", "claude", "access"];

/** Modules that (transitively) depend on `id`, among `mods`. */
export function dependentsOf(mods: Dep[], id: string): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of mods) {
      if (out.has(m.id) || m.id === id) continue;
      if (m.depends.some((d) => d === id || out.has(d))) { out.add(m.id); grew = true; }
    }
  }
  return [...out];
}

/** `id` plus everything it (transitively) depends on. */
export function dependenciesOf(mods: Dep[], id: string): string[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const out = new Set<string>();
  const visit = (x: string) => {
    for (const d of byId.get(x)?.depends ?? []) if (!out.has(d)) { out.add(d); visit(d); }
  };
  visit(id);
  return [...out];
}

/**
 * One toggle in the profile step: switching a module on also switches on what it needs; switching
 * it off also switches off what needs it. Required modules never change. Returns the new on/off map
 * for the optional modules.
 */
export function toggleModule(mods: Dep[], current: Record<string, boolean>, id: string, on: boolean) {
  const next = { ...current };
  if (REQUIRED_IDS.includes(id) || !(id in next)) return next;
  next[id] = on;
  if (on) { for (const d of dependenciesOf(mods, id)) if (d in next) next[d] = true; }
  else { for (const d of dependentsOf(mods, id)) if (d in next) next[d] = false; }
  return next;
}

