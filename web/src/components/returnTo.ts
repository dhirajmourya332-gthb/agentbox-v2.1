/**
 * Where to go back to after a setup that an agent's card started ("Set up now"): the page the owner
 * was on, per setup session, for this browser tab only (sessionStorage). The Setup workspace shows a
 * "Back to …" link and returns there once the request(s) it was opened for are finished.
 */
export type SetupReturn = { hash: string; label: string; requests: string[] };
const key = (sessionId: string) => `agentbox.setupReturn.${sessionId}`;

export function rememberReturn(sessionId: string, entry: { hash: string; label: string; request: string }) {
  try {
    const prev = returnFor(sessionId);
    const next: SetupReturn = {
      hash: prev?.hash ?? entry.hash, label: prev?.label ?? entry.label,
      requests: [...new Set([...(prev?.requests ?? []), entry.request])],
    };
    sessionStorage.setItem(key(sessionId), JSON.stringify(next));
  } catch { /* storage unavailable: no way back, the workspace still works */ }
}

export function returnFor(sessionId: string): SetupReturn | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(key(sessionId)) ?? "null");
    return v && typeof v.hash === "string" && v.hash.startsWith("#") && Array.isArray(v.requests) ? v : null;
  } catch { return null; }
}

export function clearReturn(sessionId: string) {
  try { sessionStorage.removeItem(key(sessionId)); } catch { /* storage unavailable */ }
}
