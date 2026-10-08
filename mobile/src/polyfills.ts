import { getRandomValues } from "expo-crypto";

/**
 * Hermes has no `crypto.getRandomValues`. @noble only needs it for its own randomBytes helper
 * (we pass our own key material and nonces from expo-crypto), but wire it to the OS CSPRNG anyway
 * so nothing can fall back to a weak source.
 */
const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") {
  g.crypto.getRandomValues = getRandomValues;
}
