import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import * as keyring from "./keyring";
import { api, configure, forgetDevice, isHalted, NotRecognizedError, onHalt } from "./api";
import { clearPending, unregisterPush } from "./push";
import { clearVoicePrefs } from "./speech";
import { loadPairing, savePairing, unlockKey, wipeAll, type Pairing } from "./vault";

/**
 * The app's security state machine:
 *
 *   boot → unpaired → (pair) → pending → ready
 *   boot → locked → (unlock) → pending | ready
 *   any signed 404 → unrecognized → (pair again) → unpaired
 *   ready/pending → (2 min in background, or Lock) → locked   [key wiped from memory]
 */

export type Phase =
  | { name: "boot" }
  | { name: "unpaired" }
  | { name: "locked"; pairing: Pairing }
  | { name: "pending"; pairing: Pairing }
  | { name: "ready"; pairing: Pairing }
  | { name: "unrecognized"; pairing: Pairing | null };

type Session = {
  phase: Phase;
  unlock: () => Promise<void>;
  lock: () => void;
  forget: () => Promise<void>;
  /** After a successful claim: key already saved; hold it in memory and wait for approval. */
  startPending: (pairing: Pairing, privateKey: Uint8Array) => void;
  markActive: (pairing: Pairing) => Promise<void>;
  /** From the "not paired any more" screen: unlock and ask the server again. */
  retry: () => void;
};

export const LOCK_AFTER_MS = 2 * 60 * 1000;

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ name: "boot" });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    loadPairing()
      .then((p) => setPhase(p ? { name: "locked", pairing: p } : { name: "unpaired" }))
      .catch(() => setPhase({ name: "unpaired" }));
  }, []);

  const lock = useCallback(() => {
    keyring.wipe();
    configure(null);
    const p = phaseRef.current;
    if (p.name === "ready" || p.name === "pending") setPhase({ name: "locked", pairing: p.pairing });
  }, []);

  // Any signed 404: stop everything, drop the key from memory, show the re-pair screen.
  useEffect(() => onHalt(() => {
    keyring.wipe();
    const p = phaseRef.current;
    setPhase({ name: "unrecognized", pairing: "pairing" in p ? p.pairing : null });
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
    const key = await unlockKey(pairing.keyMode); // throws on cancel / failure
    keyring.load(key, pairing.deviceId);
    configure(pairing.gateway);
    try {
      const who = await api.whoami();
      if (who.status === "active") {
        if (pairing.status !== "active") await savePairing({ ...pairing, status: "active" });
        setPhase({ name: "ready", pairing: { ...pairing, status: "active" } });
      } else {
        setPhase({ name: "pending", pairing });
      }
    } catch (e) {
      if (e instanceof NotRecognizedError || isHalted()) return; // onHalt already switched screens
      // Offline: let them in; screens show connection errors and retry.
      setPhase(pairing.status === "active" ? { name: "ready", pairing } : { name: "pending", pairing });
    }
  }, []);

  const forget = useCallback(async () => {
    // Best effort: remove the push token, then ask the gateway to delete this device (only
    // possible while unlocked; the server also drops the token when the device goes).
    await unregisterPush();
    clearPending();
    await forgetDevice();
    keyring.wipe();
    configure(null);
    await Promise.allSettled([wipeAll(), clearVoicePrefs()]);
    setPhase({ name: "unpaired" });
  }, []);

  const startPending = useCallback((pairing: Pairing, privateKey: Uint8Array) => {
    keyring.load(privateKey, pairing.deviceId);
    configure(pairing.gateway);
    setPhase({ name: "pending", pairing });
  }, []);

  const markActive = useCallback(async (pairing: Pairing) => {
    const next = { ...pairing, status: "active" as const };
    await savePairing(next);
    setPhase({ name: "ready", pairing: next });
  }, []);

  const retry = useCallback(() => {
    const p = phaseRef.current;
    if (p.name === "unrecognized" && p.pairing) setPhase({ name: "locked", pairing: p.pairing });
  }, []);

  const value = useMemo(() => ({ phase, unlock, lock, forget, startPending, markActive, retry }),
    [phase, unlock, lock, forget, startPending, markActive, retry]);
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
