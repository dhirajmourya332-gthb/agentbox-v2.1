/**
 * Secret redaction for text the setup agent reads from the owner's terminal (read_terminal) and for
 * the output of plan checks. Logins happen in that terminal, so tokens, keys and passwords can pass
 * through it; the agent must never see them. Over-redacting is fine, missing one is not.
 *
 * Covered: AWS access key ids (AKIA…/ASIA…) and 40-char secrets after aws_secret_access_key /
 * "Secret Access Key"; GitHub tokens (gh[pousr]_…, github_pat_…); GitLab glpat-…; JWTs;
 * Authorization headers; private-key blocks; one-time device codes; and long base64/hex values after
 * token / secret / password / key keywords (plus any value of password=…).
 */

export const MARK = "[REDACTED]";

type Rule = { name: string; re: RegExp; fn: (...m: string[]) => string };

/** A value that looks like a credential rather than a word, a path or a URL. */
function credentialLike(v: string) {
  if (v.length < 16) return false;
  if (/^[0-9a-fA-F]{16,}$/.test(v)) return true;
  if (v.startsWith("/") || v.startsWith("./") || v.startsWith("~") || /^[a-z]+:\/\//i.test(v)) return false;
  if (/^[A-Za-z]+$/.test(v) && v.length < 32) return false; // a plain long word
  return /[0-9]/.test(v) || /[A-Z]/.test(v) && /[a-z]/.test(v) && v.length >= 20 || /[+/=_-]/.test(v) && v.length >= 20;
}

const RULES: Rule[] = [
  // PEM private keys (an unterminated block is redacted to the end).
  {
    name: "private-key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    fn: (_m, kind) => `-----BEGIN ${kind ?? ""}PRIVATE KEY----- ${MARK} -----END ${kind ?? ""}PRIVATE KEY-----`,
  },
  // AWS secret access key after its name: env var, credentials file, `aws configure` prompt ("[None]: …").
  {
    name: "aws-secret",
    re: /(aws[_ -]?secret[_ -]?access[_ -]?key|secret[_ -]?access[_ -]?key)((?:\s*\[[^\]\n]*\])?\s*["']?\s*[:=]?\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    fn: (_m, name, sep) => `${name}${sep}${MARK}`,
  },
  // aws_session_token and similar long session tokens.
  {
    name: "aws-session",
    re: /(aws[_ -]?session[_ -]?token|session[_ -]?token)((?:\s*\[[^\]\n]*\])?\s*["']?\s*[:=]?\s*["']?)([A-Za-z0-9/+=]{16,})/gi,
    fn: (_m, name, sep) => `${name}${sep}${MARK}`,
  },
  { name: "aws-key-id", re: /\b((?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|AIPA|ABIA|ACCA)[A-Z0-9]{12,20})\b/g, fn: (m) => `${m.slice(0, 4)}${MARK}` },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, fn: () => `github_pat_${MARK}` },
  { name: "github", re: /\b(gh[pousr])_[A-Za-z0-9]{20,}/g, fn: (_m, p) => `${p}_${MARK}` },
  { name: "gitlab", re: /\bglpat-[A-Za-z0-9_-]{16,}/g, fn: () => `glpat-${MARK}` },
  { name: "gitlab-other", re: /\bgl(?:ptt|dt|rt|cbt|imt|ft|agent|oas|soat)-[A-Za-z0-9_-]{16,}/g, fn: (m) => `${m.split("-")[0]}-${MARK}` },
  { name: "slack", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, fn: (m) => `${m.slice(0, 5)}${MARK}` },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, fn: () => `${MARK}(jwt)` },
  // Authorization: Bearer x / Basic x / token x (headers, curl -H, http dumps).
  {
    name: "authorization",
    re: /((?:proxy-)?authorization\s*[:=]\s*["']?)(?:(bearer|basic|token|digest|aws4-hmac-sha256|negotiate)\s+)?([^\s"',]+(?:,\s*[A-Za-z]+=[^\s"',]+)*)/gi,
    fn: (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ""}${MARK}`,
  },
  // Credentials in URLs: https://user:secret@host
  { name: "url-userinfo", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, fn: (_m, a, _p, c) => `${a}${MARK}${c}` },
  // A one-time device code ("First copy your one-time code: ABCD-1234").
  { name: "device-code", re: /(one[- ]time code:?\s*)([A-Z0-9]{4}-[A-Z0-9]{4})/gi, fn: (_m, a) => `${a}${MARK}` },
  // password=anything (flags, env, URLs' query strings). Prompts ("Password:") are never echoed.
  { name: "password-assign", re: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd)[A-Za-z0-9_.-]*\s*=\s*["']?)([^\s"'&]+)/gi, fn: (_m, a) => `${a}${MARK}` },
  // Generic: a long credential-looking value after a token / secret / password / key name.
  {
    name: "generic",
    re: /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?|["']?\s+)([A-Za-z0-9+/=_.~-]{16,})/gi,
    fn: (m, name, sep, value) => {
      // "key" alone with a space separator is too common in prose ("key fingerprint is …"): needs : or =.
      if (/^\s+$/.test(sep.replace(/["']/g, "")) && !/token|secret|password|passwd/i.test(name)) return m;
      return credentialLike(value) ? `${name}${sep}${MARK}` : m;
    },
  },
];

/** Redact every secret we recognise. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.fn as any);
  return out;
}

/** Which rules fired (tests, and a note to the agent that something was hidden). */
export function redactionCount(before: string, after: string) {
  return before === after ? 0 : (after.match(/\[REDACTED\]/g)?.length ?? 0);
}
