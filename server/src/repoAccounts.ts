import { execFile } from "node:child_process";
import { isConnected, refreshIntegrations } from "./integrations.ts";
import { listRepos, urlKey, type Provider } from "./repos.ts";

/**
 * "Add repo › From a connected account": the repos the connected code-hosting accounts can see.
 * GitHub through `gh repo list` (the user and their orgs), GitLab through `glab repo list`, Bitbucket
 * through the integration's helper (`agentbox-bitbucket api`). Only connected integrations are asked;
 * every command runs as the portal's own user (no sudo). URLs come back without credentials.
 */

export type AccountRepo = {
  provider: Provider; full_name: string; url: string; ssh_url: string | null; description: string;
  default_branch: string | null; private: boolean; archived: boolean; updated_at: string | null; added: string | null;
};

const noUserinfo = (u: unknown) => (typeof u === "string" ? u.replace(/^(https?:\/\/)[^/@]+@/i, "$1") : "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** `gh repo list --json name,nameWithOwner,url,sshUrl,description,defaultBranchRef,isPrivate,isArchived,updatedAt`. */
export function parseGhRepos(json: string): Omit<AccountRepo, "added">[] {
  const v = JSON.parse(json || "[]");
  if (!Array.isArray(v)) throw new Error("gh: expected a list");
  return v.filter((r) => r && typeof r.nameWithOwner === "string" && typeof r.url === "string").map((r) => ({
    provider: "github" as const, full_name: r.nameWithOwner, url: noUserinfo(r.url).replace(/\/?$/, ".git").replace(/\.git\.git$/, ".git"),
    ssh_url: str(r.sshUrl) || null, description: str(r.description), default_branch: str(r.defaultBranchRef?.name) || null,
    private: r.isPrivate === true || r.visibility === "PRIVATE", archived: r.isArchived === true, updated_at: str(r.updatedAt) || null,
  }));
}

/** `glab repo list --output json` (GitLab's project objects). */
export function parseGlabRepos(json: string): Omit<AccountRepo, "added">[] {
  const v = JSON.parse(json || "[]");
  if (!Array.isArray(v)) throw new Error("glab: expected a list");
  return v.filter((r) => r && typeof r.path_with_namespace === "string" && typeof r.http_url_to_repo === "string").map((r) => ({
    provider: "gitlab" as const, full_name: r.path_with_namespace, url: noUserinfo(r.http_url_to_repo), ssh_url: str(r.ssh_url_to_repo) || null,
    description: str(r.description), default_branch: str(r.default_branch) || null, private: r.visibility === "private" || r.visibility === "internal",
    archived: r.archived === true, updated_at: str(r.last_activity_at) || null,
  }));
}

/** Bitbucket Cloud's `/repositories?role=member` page (`values`). */
export function parseBitbucketRepos(json: string): Omit<AccountRepo, "added">[] {
  const v = JSON.parse(json || "{}");
  const values = Array.isArray(v?.values) ? v.values : [];
  return values.filter((r: any) => r && typeof r.full_name === "string").map((r: any) => {
    const clone = Array.isArray(r.links?.clone) ? r.links.clone : [];
    return {
      provider: "bitbucket" as const, full_name: r.full_name,
      url: noUserinfo(clone.find((c: any) => c?.name === "https")?.href) || `https://bitbucket.org/${r.full_name}.git`,
      ssh_url: str(clone.find((c: any) => c?.name === "ssh")?.href) || null, description: str(r.description),
      default_branch: str(r.mainbranch?.name) || null, private: r.is_private === true, archived: false, updated_at: str(r.updated_on) || null,
    };
  });
}

function runJson(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => (err ? reject(new Error(`${cmd}: ${(String(stderr).trim().split("\n").pop() || err.message).slice(0, 300)}`)) : resolve(String(stdout))));
  });
}

const GH_FIELDS = "name,nameWithOwner,url,sshUrl,description,defaultBranchRef,isPrivate,isArchived,updatedAt";

export type AccountListing = { accounts: { provider: Provider; ok: boolean; error: string | null; count: number }[]; repos: AccountRepo[] };

let cache: { at: number; data: AccountListing } | null = null;

export async function accountRepos(opts: { refresh?: boolean; connected?: (id: string) => boolean } = {}): Promise<AccountListing> {
  if (!opts.refresh && cache && Date.now() - cache.at < 5 * 60_000) return mark(cache.data);
  if (!opts.connected) await refreshIntegrations(60_000);
  const connected = opts.connected ?? isConnected;
  const gh = process.env.AGENTBOX_GH ?? "gh";
  const glab = process.env.AGENTBOX_GLAB ?? "glab";
  const bb = process.env.AGENTBOX_BITBUCKET ?? "agentbox-bitbucket";
  const jobs: { provider: Provider; run: () => Promise<Omit<AccountRepo, "added">[]> }[] = [];
  if (connected("github")) {
    jobs.push({ provider: "github", run: async () => {
      const own = parseGhRepos(await runJson(gh, ["repo", "list", "--limit", "200", "--json", GH_FIELDS]));
      let orgs: string[] = [];
      try { orgs = (await runJson(gh, ["api", "user/orgs", "--jq", ".[].login"], 30_000)).split("\n").map((s) => s.trim()).filter((s) => /^[\w.-]+$/.test(s)); } catch { /* no org scope */ }
      const more = await Promise.all(orgs.slice(0, 20).map((o) => runJson(gh, ["repo", "list", o, "--limit", "200", "--json", GH_FIELDS]).then(parseGhRepos).catch(() => [])));
      return [...own, ...more.flat()];
    } });
  }
  if (connected("gitlab")) jobs.push({ provider: "gitlab", run: async () => parseGlabRepos(await runJson(glab, ["repo", "list", "--per-page", "100", "--output", "json"])) });
  if (connected("bitbucket")) jobs.push({ provider: "bitbucket", run: async () => parseBitbucketRepos(await runJson(bb, ["api", "/repositories?role=member&pagelen=100"])) });
  const results = await Promise.all(jobs.map(async (j) => {
    try { const list = await j.run(); return { provider: j.provider, ok: true, error: null, list }; } catch (e: any) { return { provider: j.provider, ok: false, error: String(e.message), list: [] }; }
  }));
  const seen = new Set<string>();
  const repos: AccountRepo[] = [];
  for (const r of results.flatMap((x) => x.list)) {
    const k = urlKey(r.url) ?? r.full_name;
    if (seen.has(k)) continue;
    seen.add(k);
    repos.push({ ...r, added: null });
  }
  repos.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const data: AccountListing = { accounts: results.map((x) => ({ provider: x.provider, ok: x.ok, error: x.error, count: x.list.length })), repos };
  cache = { at: Date.now(), data };
  return mark(data);
}

/** Which of them are already added (by URL). */
function mark(d: AccountListing): AccountListing {
  const added = new Map(listRepos({ archived: false }).map((r) => [urlKey(r.url), r.name]));
  return { ...d, repos: d.repos.map((r) => ({ ...r, added: added.get(urlKey(r.url)) ?? (r.ssh_url ? added.get(urlKey(r.ssh_url)) : undefined) ?? null })) };
}
