import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import * as keyring from "./keyring";
import { api, configure, forgetDevice, isHalted, NotRecognizedError, onHalt } from "./api";
import { clearPending, clearPushPrefs, unregisterPush } from "./push";
import { clearVoicePrefs } from "./speech";
import { loadServers, removeServer, saveServer, setActive, unlockKey, wipeAll, type Pairing } from "./vault";

/**
 * The app's security state machine, for the active agentbox (the phone can be paired with several,
 * one key each; only the active one's key is ever in memory):
 *
 *   boot → unpaired → (pair) → pending → ready
 *   boot → locked → (unlock) → pending | ready
 *   ready → (add an agentbox) → adding → (pair) → pending → ready      [cancel: back where it was]
 *   ready → (switch) → locked (the other agentbox) → (unlock) → ready   [key wiped from memory]
 *   any signed 404 → unrecognized → (pair again | switch | try again)
 *   ready/pending → (2 min in background, or Lock) → locked   [key wiped from memory]
 */

export type Phase =
  | { name: "boot" }
  | { name: "unpaired" }
  | { name: "locked"; pairing: Pairing }
  | { name: "pending"; pairing: Pairing }
  | { name: "ready"; pairing: Pairing }
  | { name: "adding"; from: Pairing | null }
  | { name: "unrecognized"; pairing: Pairing | null };

type Session = {
  phase: Phase;
  /** Every paired agentbox, in the order they were added. */
  servers: Pairing[];
  unlock: () => Promise<void>;
  lock: () => void;
  /**
   * Forget the active agentbox (asking it to remove this phone first, when unlocked). Then the
   * next agentbox is shown locked, or with `pairNext`, the pairing screen.
   */
  forget: (pairNext?: boolean) => Promise<void>;
  /** Forget an agentbox that isn't active: local only (its key isn't loaded, so it can't be told). */
  forgetOther: (deviceId: string) => Promise<void>;
  /** Make another agentbox active: locks, then asks to unlock it. */
  switchTo: (deviceId: string) => Promise<void>;
  rename: (deviceId: string, label: string) => Promise<void>;
  /** Show the pairing screen for one more agentbox. */
  addServer: () => void;
  cancelAdd: () => void;
  /** After a successful claim: key already saved; hold it in memory and wait for approval. */
  startPending: (pairing: Pairing, privateKey: Uint8Array) => Promise<void>;
  markActive: (pairing: Pairing) => Promise<void>;
  /** From the "not paired any more" screen: unlock and ask the server again. */
  retry: () => void;
};

export const LOCK_AFTER_MS = 2 * 60 * 1000;

const Ctx = createContext<Session | null>(null);

const pairingOf = (p: Phase): Pairing | null =>
  p.name === "adding" ? p.from : "pairing" in p ? p.pairing : null;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ name: "boot" });
  const [servers, setServers] = useState<Pairing[]>([]);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    loadServers()
      .then((s) => { setServers(s.list); setPhase(s.active ? { name: "locked", pairing: s.active } : { name: "unpaired" }); })
      .catch(() => setPhase({ name: "unpaired" }));
  }, []);

  const lock = useCallback(() => {
    keyring.wipe();
    configure(null);
    const p = phaseRef.current;
    if (p.name === "ready" || p.name === "pending") setPhase({ name: "locked", pairing: p.pairing });
    else if (p.name === "adding" && p.from) setPhase({ name: "locked", pairing: p.from });
  }, []);

  // Any signed 404: stop everything, drop the key from memory, show the re-pair screen.
  useEffect(() => onHalt(() => {
    keyring.wipe();
    setPhase({ name: "unrecognized", pairing: pairingOf(phaseRef.current) });
  }), []);

  // Lock after 2 minutes in the background. Decided on return, from both clocks: wall time
  // (counts deep sleep, but can be changed by the user) and monotonic time (performance.now(),
  // can't be set, may pause in deep sleep). Lock if either says >= 2 min, or if the wall clock
  // went backwards. A timer is only a bonus: Android may not run JS while backgrounded.
  useEffect(() => {
    let away: { wall: number; mono: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") {
        if (!away) away = { wall: Date.now(), mono: performance.now() };
        clearTimeout(timer);
        timer = setTimeout(lock, LOCK_AFTER_MS);
        return;
      }
      clearTimeout(timer);
      if (away) {
        const wall = Date.now() - away.wall;
        const mono = performance.now() - away.mono;
        away = null;
        if (wall < 0 || wall >= LOCK_AFTER_MS || mono >= LOCK_AFTER_MS) lock();
      }
    });
    return () => { sub.remove(); clearTimeout(timer); };
  }, [lock]);

  const unlock = useCallback(async () => {
    const p = phaseRef.current;
    if (p.name !== "locked") return;
    const pairing = p.pairing;
    const key = await unlockKey(pairing); // throws on cancel / failure
    keyring.load(key, pairing.deviceId);
    configure(pairing.gateway);
    try {
      const who = await api.whoami();
      if (who.status === "active") {
        const next = { ...pairing, status: "active" as const };
        if (pairing.status !== "active") setServers((await saveServer(next)).list);
        setPhase({ name: "ready", pairing: next });
      } else {
        setPhase({ name: "pending", pairing });
      }
    } catch (e) {
      if (e instanceof NotRecognizedError || isHalted()) return; // onHalt already switched screens
      // Offline: let them in; screens show connection errors and retry.
      setPhase(pairing.status === "active" ? { name: "ready", pairing } : { name: "pending", pairing });
    }
  }, []);

  const forget = useCallback(async (pairNext = false) => {
    const target = pairingOf(phaseRef.current);
    // Best effort: remove the push token, then ask the gateway to delete this device (only
    // possible while unlocked; the server also drops the token when the device goes).
    if (keyring.isLoaded()) {
      await unregisterPush();
      await forgetDevice();
    }
    clearPending();
    keyring.wipe();
    configure(null);
    const s = target ? await removeServer(target.deviceId) : { list: [], active: null };
    setServers(s.list);
    if (!s.list.length) {
      await Promise.allSettled([wipeAll(), clearVoicePrefs(), clearPushPrefs()]);
      setPhase({ name: "unpaired" });
    } else if (pairNext) {
      setPhase({ name: "adding", from: s.active });
    } else {
      setPhase(s.active ? { name: "locked", pairing: s.active } : { name: "unpaired" });
    }
  }, []);

  const forgetOther = useCallback(async (deviceId: string) => {
    // The unlocked one goes through forget (it can tell its agentbox); judged by the key in memory,
    // not the phase, which may not have caught up yet (e.g. right after pairing a replacement).
    if (keyring.currentDevice() === deviceId) return forget();
    setServers((await removeServer(deviceId)).list);
  }, [forget]);

  const switchTo = useCallback(async (deviceId: string) => {
    const s = await setActive(deviceId);
    if (s.active?.deviceId !== deviceId) return;
    clearPending();
    keyring.wipe();
    configure(null);
    setServers(s.list);
    setPhase({ name: "locked", pairing: s.active });
  }, []);

  const rename = useCallback(async (deviceId: string, label: string) => {
    const p = servers.find((x) => x.deviceId === deviceId);
    if (!p) return;
    const clean = label.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 40);
    const next = { ...p, label: clean || undefined };
    setServers((await saveServer(next)).list);
    const cur = phaseRef.current;
    if ((cur.name === "ready" || cur.name === "pending" || cur.name === "locked") && cur.pairing.deviceId === deviceId) {
      setPhase({ ...cur, pairing: next });
    }
  }, [servers]);

  const addServer = useCallback(() => {
    setPhase({ name: "adding", from: pairingOf(phaseRef.current) });
  }, []);

  const cancelAdd = useCallback(() => {
    const p = phaseRef.current;
    if (p.name !== "adding") return;
    if (!p.from) setPhase({ name: "unpaired" });
    // Still unlocked for the one we came from (adding doesn't touch its key): go straight back.
    else if (keyring.currentDevice() === p.from.deviceId) {
      configure(p.from.gateway);
      setPhase(p.from.status === "active" ? { name: "ready", pairing: p.from } : { name: "pending", pairing: p.from });
    } else setPhase({ name: "locked", pairing: p.from });
  }, []);

  const startPending = useCallback(async (pairing: Pairing, privateKey: Uint8Array) => {
    keyring.load(privateKey, pairing.deviceId);
    configure(pairing.gateway);
    setServers((await saveServer(pairing, true)).list);
    setPhase({ name: "pending", pairing });
  }, []);

  const markActive = useCallback(async (pairing: Pairing) => {
    const next = { ...pairing, status: "active" as const };
    setServers((await saveServer(next, true)).list);
    setPhase({ name: "ready", pairing: next });
  }, []);

  const retry = useCallback(() => {
    const p = phaseRef.current;
    if (p.name === "unrecognized" && p.pairing) setPhase({ name: "locked", pairing: p.pairing });
  }, []);

  const value = useMemo(() => ({ phase, servers, unlock, lock, forget, forgetOther, switchTo, rename, addServer, cancelAdd, startPending, markActive, retry }),
    [phase, servers, unlock, lock, forget, forgetOther, switchTo, rename, addServer, cancelAdd, startPending, markActive, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

/** The pairing, for screens that only render while ready. */
export function usePairing(): Pairing {
  const { phase } = useSession();
  if (phase.name !== "ready" && phase.name !== "pending") throw new Error("Not unlocked");
  return phase.pairing;
}
