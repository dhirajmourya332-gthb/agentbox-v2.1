/**
 * The first-run "profile" step (docs/V2-ARCHITECTURE.md § 10.1): the only choice is how the owner
 * will reach agentbox (the access mode). No module picking: the first run sets up the base for
 * everyone, and integrations are connected later from the portal. Pure, shared by the guide
 * server and the page (no Node imports here).
 */
export type AccessMode = "tailscale" | "cloudflare" | "ssh-tunnel";

export const ACCESS_MODES: { id: AccessMode; title: string; description: string; recommended?: boolean }[] = [
  {
    id: "tailscale", recommended: true, title: "Tailscale",
    description: "The portal on your private tailnet only (https://<name>.ts.net). Needs a free Tailscale account and the app on your devices. Also what the phone app uses.",
  },
  {
    id: "cloudflare", title: "Cloudflare Tunnel + Access",
    description: "The portal at a hostname on your Cloudflare domain, behind Cloudflare Access (SSO or an email code; only your email is let in). No VPN client needed.",
  },
  {
    id: "ssh-tunnel", title: "SSH tunnel (localhost only)",
    description: "Nothing is published: you open the portal through an SSH, SSM or IAP port forward from your computer (on Lima, the forwarded localhost port).",
  },
];

export const isAccessMode = (v: unknown): v is AccessMode => ACCESS_MODES.some((m) => m.id === v);

/** The integrations the Finish card points to (connected later from the portal). */
export const NEXT_INTEGRATIONS = "GitHub/GitLab/Bitbucket, AWS/GCP/Azure, Kubernetes…";
