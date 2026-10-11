// Integrations (docs/V2-ARCHITECTURE.md § 10, docs/MODULES.md): the pure parts the `agentbox
// integration` commands are built from, kept apart so they can be unit-tested without a VM:
//   - render(): a tiny mustache-like template renderer;
//   - normalizeSchema() / validateSettings() / parseAssignments(): the settings schema;
//   - integrationState() / stepViews(): the state machine behind `integration status --json`.
// No I/O here except what the caller passes in.

export const CATEGORIES = ["code-hosting", "cloud", "cluster", "database", "chat", "extras"];
export const STATES = ["available", "connecting", "connected", "error", "disconnected", "unavailable"];
const KEY = /^[a-z][a-z0-9_]*$/;
const TYPES = ["string", "boolean", "list", "enum", "number"];

// --- the renderer --------------------------------------------------------------------------------

/**
 * Render a template with a context (plain object). Supported, and nothing else:
 *   {{key}} / {{a.b}}       the value (lists joined with ", "; missing, null or false → "")
 *   {{#key}}…{{/key}}       the block if the value is truthy (non-empty string, true, non-zero
 *                           number, non-empty list); for a list, once per item with {{.}} = the item
 *   {{^key}}…{{/key}}       the block if the value is falsy
 *   {{! comment }}          dropped
 * No HTML escaping (the output is Markdown). Unbalanced sections throw.
 */
export function render(template, context) {
  const tokens = tokenize(String(template ?? ""));
  const [tree, rest] = parseTokens(tokens, 0, null);
  if (rest !== tokens.length) throw new Error("template: unexpected {{/…}}");
  return renderTree(tree, [context ?? {}]);
}

function tokenize(s) {
  // A section, closing or comment tag alone on its line takes the whole line with it (like
  // mustache's standalone tags), so templates can put {{#x}} on its own line without blank lines.
  s = s.replace(/^[ \t]*(\{\{\s*[#^/!][^}]*\}\})[ \t]*(\r?\n|$)/gm, "$1");
  const out = [];
  const re = /\{\{\s*([#^/!]?)\s*([^}]*?)\s*\}\}/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== "!") out.push({ t: m[1] || "var", v: m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

function parseTokens(tokens, i, open) {
  const out = [];
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.t === "/") {
      if (open === null) throw new Error(`template: {{/${tok.v}}} without an opening tag`);
      if (tok.v !== open) throw new Error(`template: {{/${tok.v}}} closes {{#${open}}}`);
      return [out, i + 1];
    }
    if (tok.t === "#" || tok.t === "^") {
      const [body, next] = parseTokens(tokens, i + 1, tok.v);
      if (next > tokens.length || tokens[next - 1]?.t !== "/") throw new Error(`template: {{${tok.t}${tok.v}}} is never closed`);
      out.push({ t: tok.t, v: tok.v, body });
      i = next;
      continue;
    }
    out.push(tok);
    i++;
  }
  if (open !== null) throw new Error(`template: {{#${open}}} is never closed`);
  return [out, i];
}

function lookup(stack, name) {
  if (name === ".") return stack[stack.length - 1];
  const parts = name.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    let v = stack[i];
    if (v === null || typeof v !== "object" || !(parts[0] in v)) continue;
    for (const p of parts) {
      if (v === null || typeof v !== "object" || !(p in v)) return undefined;
      v = v[p];
    }
    return v;
  }
  return undefined;
}

const truthy = (v) => Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : !!v;
const show = (v) => (v === undefined || v === null || v === false) ? "" : Array.isArray(v) ? v.map(String).join(", ") : String(v);

function renderTree(tree, stack) {
  let out = "";
  for (const n of tree) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") out += show(lookup(stack, n.v));
    else if (n.t === "#") {
      const v = lookup(stack, n.v);
      if (!truthy(v)) continue;
      if (Array.isArray(v)) for (const item of v) out += renderTree(n.body, [...stack, item]);
      else out += renderTree(n.body, typeof v === "object" ? [...stack, v] : stack);
    } else if (n.t === "^") {
      if (!truthy(lookup(stack, n.v))) out += renderTree(n.body, stack);
    }
  }
  return out;
}

// --- the settings schema ------------------------------------------------------------------------------

/**
 * A manifest's `settings:` list, normalised:
 *   { key, prompt, type: string|boolean|list|enum|number, required, default?, options? (enum),
 *     pattern? (a regex every string / list item must match), example? }
 * Throws on a malformed schema (it's a bug in the manifest, caught by the tests).
 */
export function normalizeSchema(raw, where = "settings") {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: a list`);
  const seen = new Set();
  return raw.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`${where}[${i}]: an object`);
    if (typeof s.key !== "string" || !KEY.test(s.key)) throw new Error(`${where}[${i}].key: lower_snake_case`);
    if (seen.has(s.key)) throw new Error(`${where}: ${s.key} twice`);
    seen.add(s.key);
    const type = s.type ?? (Array.isArray(s.options) ? "enum" : "string");
    if (!TYPES.includes(type)) throw new Error(`${where}.${s.key}.type: one of ${TYPES.join(", ")}`);
    if (type === "enum" && !(Array.isArray(s.options) && s.options.length && s.options.every((o) => typeof o === "string" && KEY.test(o.replace(/-/g, "_"))))) {
      throw new Error(`${where}.${s.key}.options: a list of simple words`);
    }
    if (s.pattern !== undefined) { try { new RegExp(s.pattern); } catch { throw new Error(`${where}.${s.key}.pattern: a regex`); } }
    const out = {
      key: s.key,
      prompt: String(s.prompt ?? s.key),
      type,
      required: s.required === true,
    };
    if (s.default !== undefined) out.default = s.default;
    if (type === "enum") out.options = s.options;
    if (s.pattern !== undefined) out.pattern = String(s.pattern);
    if (s.example !== undefined) out.example = String(s.example);
    if (s.default !== undefined) {
      const r = coerce(out, s.default);
      if (r.error) throw new Error(`${where}.${s.key}.default: ${r.error}`);
      out.default = r.value;
    }
    return out;
  });
}

const MAX_LEN = 300;
// A value that looks like a credential (settings are not secret, and end up in rendered files).
const SECRETISH = /(gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{15,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|ATATT[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/;

/** One value against its schema entry: { value } or { error }. Strings are trimmed. */
export function coerce(def, raw) {
  const str = (v) => {
    if (typeof v !== "string" && typeof v !== "number") return { error: "a text value" };
    const s = String(v).trim();
    if (s.length > MAX_LEN) return { error: `at most ${MAX_LEN} characters` };
    if (/[\n\r\0]/.test(s)) return { error: "one line" };
    if (/\{\{|\}\}/.test(s)) return { error: "no {{ or }}" };
    if (SECRETISH.test(s)) return { error: "this looks like a secret; settings are not secret. Use `agentbox secret set` or the provider's login instead" };
    if (def.pattern && s !== "" && !new RegExp(def.pattern).test(s)) return { error: `must match ${def.pattern}${def.example ? ` (e.g. ${def.example})` : ""}` };
    return { value: s };
  };
  switch (def.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "yes") return { value: true };
      if (raw === "false" || raw === "no") return { value: false };
      return { error: "true or false" };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n) || String(raw).trim() === "") return { error: "a number" };
      return { value: n };
    }
    case "list": {
      const items = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
      const out = [];
      for (const it of items) {
        const r = str(it);
        if (r.error) return { error: `each item: ${r.error}` };
        if (r.value !== "") out.push(r.value);
      }
      if (out.length > 50) return { error: "at most 50 items" };
      return { value: out };
    }
    case "enum": {
      const r = str(raw);
      if (r.error) return r;
      if (r.value === "") return { value: "" };
      if (!def.options.includes(r.value)) return { error: `one of ${def.options.join(", ")}` };
      return r;
    }
    default: return str(raw);
  }
}

const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Validate a whole settings object against the schema.
 * Returns { values (unknown keys dropped, coerced), errors: [{key, error}], missing: [required keys
 * without a value] }. `partial` skips the required check (an update of a few keys).
 */
export function validateSettings(schema, values, { partial = false } = {}) {
  const errors = [], out = {};
  const byKey = new Map(schema.map((d) => [d.key, d]));
  const src = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  for (const [k, v] of Object.entries(src)) {
    const def = byKey.get(k);
    if (!def) { errors.push({ key: k, error: "not a setting of this integration" }); continue; }
    if (v === null) continue;
    const r = coerce(def, v);
    if (r.error) errors.push({ key: k, error: r.error });
    else out[k] = r.value;
  }
  const missing = partial ? [] : schema.filter((d) => d.required && empty(out[d.key]) && empty(d.default)).map((d) => d.key);
  return { values: out, errors, missing };
}

/** `--set k=v` / `k=` (clears) arguments → an object. */
export function parseAssignments(list) {
  const out = {};
  for (const a of list) {
    const i = a.indexOf("=");
    if (i <= 0) throw new Error(`expected key=value, got: ${a}`);
    const k = a.slice(0, i).trim(), v = a.slice(i + 1);
    out[k] = v === "" ? null : v;
  }
  return out;
}

/**
 * The render context for an integration's templates: the defaults, then the saved values; plus,
 * for every enum setting, `<key>_<option>: true` for the chosen option (so a template can say
 * {{#provider_eks}}…{{/provider_eks}}), for every list setting `has_<key>` (non-empty?), plus
 * `paths` and `user` from the config.
 */
export function renderContext(schema, saved, conf = {}) {
  const ctx = {};
  for (const d of schema) {
    const v = saved?.[d.key];
    ctx[d.key] = empty(v) ? (d.default ?? (d.type === "list" ? [] : d.type === "boolean" ? false : "")) : v;
    if (d.type === "enum" && ctx[d.key]) ctx[`${d.key}_${String(ctx[d.key]).replace(/-/g, "_")}`] = true;
    // A section over a list repeats once per item; has_<key> is the plain "is it non-empty?".
    if (d.type === "list") ctx[`has_${d.key}`] = ctx[d.key].length > 0;
  }
  ctx.paths = conf.paths ?? {};
  ctx.user = conf.user ?? "";
  return ctx;
}

// --- the integration manifest ---------------------------------------------------------------------------

/**
 * The integration-specific keys of a module.yaml, normalised (throws on a malformed manifest):
 *   kind, category, available, settings, instructions { summary, file }, skills, default_roles,
 *   account (a read-only command printing the connected account), revoke (how to revoke the login).
 */
export function normalizeIntegration(m) {
  const where = `setup/modules/${m.id}/module.yaml`;
  if (m.kind !== "integration") throw new Error(`${where}: not kind: integration`);
  if (!CATEGORIES.includes(m.category)) throw new Error(`${where}: category must be one of ${CATEGORIES.join(", ")}`);
  const list = (v, k) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && /^[a-z0-9-]+$/.test(x))) throw new Error(`${where}: ${k} must be a list of ids`);
    return v;
  };
  const ins = m.instructions ?? {};
  if (typeof ins !== "object") throw new Error(`${where}: instructions must be a map`);
  if (ins.file !== undefined && (typeof ins.file !== "string" || ins.file.includes("/") || ins.file.startsWith("."))) throw new Error(`${where}: instructions.file is a file name in the module folder`);
  return {
    ...m,
    available: m.available !== false,
    settings: normalizeSchema(m.settings, `${where}: settings`),
    instructions: { summary: typeof ins.summary === "string" ? ins.summary.trim() : "", file: ins.file ?? null },
    skills: list(m.skills, "skills"),
    default_roles: list(m.default_roles, "default_roles"),
    account: typeof m.account === "string" ? m.account : null,
    revoke: typeof m.revoke === "string" ? m.revoke.trim() : null,
  };
}

// --- states ---------------------------------------------------------------------------------------------------

/**
 * Step views from check results, like the guide's roadmap:
 *   done      the check passed (the only way a step is done)
 *   human     a login / config gate whose earlier steps are done: the owner's turn
 *   failed    the integration is on, nothing before it waits for the owner, and its check fails
 *   pending   not reached yet (an earlier step isn't done), or the integration isn't on
 *   skipped   its `when:` is false under this config
 * `results`: step id → { ok, code, output } (no entry: no check).
 */
export function stepViews(steps, results, { enabled, applies = () => true, renderText = (s) => s }) {
  const out = [];
  let blocked = false, gateOpen = false;
  for (const s of steps) {
    const v = {
      id: s.id, title: s.title, human: !!s.human,
      state: "pending",
      check: null,
      instructions: s.instructions ? renderText(s.instructions).trim() : null,
      copy: s.copy ? renderText(s.copy) : null,
    };
    if (!applies(s)) { out.push({ ...v, state: "skipped" }); continue; }
    const r = results[s.id];
    if (r) v.check = { ok: r.ok, code: r.code, ...(r.ok ? {} : { output: r.output ?? "" }), ...(r.timedOut ? { timed_out: true } : {}) };
    if (!s.check) { out.push({ ...v, state: blocked ? "pending" : "done" }); continue; }
    if (r?.ok) { out.push({ ...v, state: "done" }); continue; }
    if (s.human) v.state = blocked || !enabled ? "pending" : "human";
    else v.state = gateOpen || !enabled ? "pending" : "failed";
    if (s.human && enabled) gateOpen = true;
    blocked = true;
    out.push(v);
  }
  return out;
}

/**
 * The integration's state (§ 10.2):
 *   unavailable   catalog entry only ("coming soon")
 *   available     never connected (off, no record)
 *   disconnected  off, after a disconnect
 *   connected     on, every applicable check green, settings saved and complete
 *   error         on, and a step failed with no gate open before it, or the last connect / verify
 *                 failed while no gate waits for the owner
 *   connecting    on, and something still waits (a human gate, missing settings, a step not run yet)
 */
export function integrationState({ available = true, enabled, steps, settingsSaved, missing = [], errors = [], last = null }) {
  if (!available) return "unavailable";
  if (!enabled) return last?.action === "disconnect" ? "disconnected" : "available";
  const live = steps.filter((s) => s.state !== "skipped");
  const green = live.every((s) => s.state === "done");
  if (green && settingsSaved && missing.length === 0 && errors.length === 0) return "connected";
  if (live.some((s) => s.state === "failed")) return "error";
  // A gate waiting for the owner explains a failed verify: still connecting, not an error.
  if (live.some((s) => s.state === "human")) return "connecting";
  if (last && last.ok === false && (last.action === "connect" || last.action === "verify")) return "error";
  return "connecting";
}

/** What the owner still has to do: the open human gates and the missing settings. */
export function remainingGates(view) {
  const out = [];
  for (const k of view.settings.missing) {
    const d = view.settings.schema.find((x) => x.key === k);
    out.push({ kind: "setting", key: k, title: d?.prompt ?? k, command: `agentbox integration settings ${view.id} --set ${k}=…` });
  }
  for (const s of view.steps) if (s.state === "human") out.push({ kind: "step", id: s.id, title: s.title, instructions: s.instructions, copy: s.copy });
  return out;
}
