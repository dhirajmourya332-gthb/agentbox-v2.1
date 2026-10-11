import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
/**
 * Module manifests (setup/modules/<id>/module.yaml, docs/V2-ARCHITECTURE.md § 3 and § 10) and the
 * profile: which modules are on, in which order, and which of their steps apply. Pure apart from
 * loadModules. The guide only sets up the **base** (kind: base); integrations (kind: integration)
 * are connected later from the portal with `agentbox integration connect`.
 */

export type StepDef = {
  id: string;
  title: string;
  run?: string;
  check?: string;
  human?: boolean;
  instructions?: string;
  copy?: string;
  when?: string;
};

export type ModuleKind = "base" | "integration";

export type ModuleDef = {
  id: string;
  kind: ModuleKind;
  title: string;
  description: string;
  optional: boolean;
  depends: string[];
  steps: StepDef[];
};

/** Always on (the CLI's REQUIRED). */
export const REQUIRED = ["core", "claude", "access"];
/** Display order between modules that don't depend on each other. */
export const PREFERRED_ORDER = ["core", "claude", "access", "terminal", "display"];

const ID = /^[a-z0-9-]+$/;

export function normalizeModule(raw: any, fallbackId: string): ModuleDef {
  const id = typeof raw?.id === "string" && ID.test(raw.id) ? raw.id : fallbackId;
  const steps: StepDef[] = (Array.isArray(raw?.steps) ? raw.steps : [])
    .filter((s: any) => s && typeof s.id === "string")
    .map((s: any) => ({
      id: s.id,
      title: String(s.title ?? s.id),
      run: typeof s.run === "string" ? s.run : undefined,
      check: typeof s.check === "string" ? s.check : undefined,
      human: s.human === true,
      instructions: typeof s.instructions === "string" ? s.instructions : undefined,
      copy: typeof s.copy === "string" ? s.copy : undefined,
      when: typeof s.when === "string" ? s.when : undefined,
    }));
  return {
    id,
    // A manifest without `kind` is treated as base (older manifests); the shipped ones all say.
    kind: raw?.kind === "integration" ? "integration" : "base",
    title: String(raw?.title ?? id),
    description: String(raw?.description ?? "").trim(),
    optional: raw?.optional !== false && !REQUIRED.includes(id),
    depends: Array.isArray(raw?.depends) ? raw.depends.filter((d: unknown) => typeof d === "string") : [],
    steps,
  };
}

/** The base modules: what the guide's first run sets up. */
export const baseOnly = (mods: ModuleDef[]) => mods.filter((m) => m.kind === "base");

/** Every setup/modules/<id>/module.yaml under the source tree. A broken manifest is skipped (and reported). */
export function loadModules(src: string, onError: (msg: string) => void = () => {}): ModuleDef[] {
  const dir = path.join(src, "setup", "modules");
  const out: ModuleDef[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e: any) {
    onError(`can't read ${dir}: ${e.code ?? e.message}`);
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !ID.test(e.name)) continue;
    const file = path.join(dir, e.name, "module.yaml");
    if (!fs.existsSync(file)) continue;
    try { out.push(normalizeModule(parse(fs.readFileSync(file, "utf8")), e.name)); } catch (err: any) {
      onError(`${file}: ${err.message}`);
    }
  }
  return out;
}

export function getIn(obj: any, parts: string[]): unknown {
  let v = obj;
  for (const p of parts) {
    if (v === null || typeof v !== "object" || !(p in v)) return undefined;
    v = v[p];
  }
  return v;
}

/**
 * A step's `when:` condition, exactly as the CLI evaluates it: `<key> == <value>` or `!=`, the value
 * optionally quoted; no condition is true. A condition we can't parse is false (the step is hidden)
 * rather than an error, so one bad manifest can't take the roadmap down.
 */
export function evalWhen(conf: unknown, cond: string | undefined | null): boolean {
  if (cond === undefined || cond === null || cond === "") return true;
  const m = /^\s*([A-Za-z0-9_.-]+)\s*(==|!=)\s*"?([^"]*?)"?\s*$/.exec(String(cond));
  if (!m) return false;
  const v = getIn(conf, m[1].split("."));
  const eq = String(v ?? "") === m[3];
  return m[2] === "==" ? eq : !eq;
}

/**
 * In the profile? Required modules always; other base modules unless the config turns them off
 * explicitly (`modules.display: false`); integrations only when the config turns them on.
 */
export function isOn(conf: any, m: Pick<ModuleDef, "id" | "kind">): boolean {
  if (REQUIRED.includes(m.id)) return true;
  const v = conf?.modules?.[m.id];
  return m.kind === "base" ? v !== false : v === true;
}

export type Profile = {
  /** The modules that will be set up, dependencies first. */
  order: string[];
  /** On in the config (or required). */
  chosen: string[];
  /** Pulled in only because something chosen depends on it. */
  implied: string[];
  /** Dependencies no manifest provides. */
  missing: string[];
  cycles: string[];
};

/**
 * The profile: the modules that are on, plus everything they depend on, in dependency order.
 * Ties follow PREFERRED_ORDER, then the id, so the roadmap is stable.
 */
export function resolveProfile(mods: ModuleDef[], conf: any): Profile {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const rank = (id: string) => { const i = PREFERRED_ORDER.indexOf(id); return i < 0 ? PREFERRED_ORDER.length : i; };
  const byRank = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
  const chosen = mods.filter((m) => isOn(conf, m)).map((m) => m.id).sort(byRank);
  const missing = new Set<string>();
  const cycles: string[] = [];
  // Closure over depends.
  const want = new Set<string>();
  const visit = (id: string, chain: string[]) => {
    if (chain.includes(id)) { cycles.push([...chain, id].join(" → ")); return; }
    const m = byId.get(id);
    if (!m) { missing.add(id); return; }
    if (want.has(id)) return;
    want.add(id);
    for (const d of m.depends) visit(d, [...chain, id]);
  };
  for (const id of chosen) visit(id, []);
  // Kahn's algorithm, picking the best-ranked ready module each time.
  const order: string[] = [];
  const left = new Set(want);
  while (left.size) {
    const ready = [...left].filter((id) => byId.get(id)!.depends.every((d) => !left.has(d) || !want.has(d))).sort(byRank);
    if (!ready.length) { order.push(...[...left].sort(byRank)); break; } // a cycle: keep going, reported above
    order.push(ready[0]);
    left.delete(ready[0]);
  }
  return { order, chosen, implied: order.filter((id) => !chosen.includes(id)), missing: [...missing], cycles };
}
