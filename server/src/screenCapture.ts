import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { displayState } from "./control.ts";

/**
 * The shared screen for clients that can't run noVNC (the phone): a JPEG snapshot of the Xvfb
 * display, and a few input actions (tap, scroll, type, a fixed set of keys). Snapshots are
 * read-only and always allowed; input needs the owner to hold the screen (Take control), the same
 * rule the portal's noVNC view follows. Uses ImageMagick's `import` and `xdotool`, which the
 * display module installs.
 */

const DISPLAY = ":99";
const env = () => ({ ...process.env, DISPLAY });
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

function exec(cmd: string, args: string[], binary = false): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: env(), timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Several viewers (or a fast poller) share one capture: at most one runs, and a result is reused
// for a short while.
const FRESH_MS = 600;
let last: { at: number; width: number; jpeg: Buffer } | null = null;
let inflight: Promise<Buffer> | null = null;

export async function snapshot(width: number): Promise<Buffer> {
  if (last && last.width === width && Date.now() - last.at < FRESH_MS) return last.jpeg;
  inflight ??= exec("import", ["-display", DISPLAY, "-window", "root", "-resize", `${width}x>`, "-quality", "65", "jpeg:-"], true)
    .then((b) => {
      const jpeg = b as Buffer;
      last = { at: Date.now(), width, jpeg };
      return jpeg;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

let geometry: { w: number; h: number } | null = null;
async function screenSize() {
  if (geometry) return geometry;
  const out = String(await exec("xdotool", ["getdisplaygeometry"])).trim().split(/\s+/).map(Number);
  if (out.length !== 2 || !out.every((n) => Number.isInteger(n) && n > 0)) throw httpError(502, "Couldn't read the screen size");
  geometry = { w: out[0], h: out[1] };
  return geometry;
}

/** Keys the phone may press. Anything else is refused. */
export const KEYS = new Set([
  "Return", "BackSpace", "Tab", "Escape", "Delete", "Up", "Down", "Left", "Right", "Page_Up", "Page_Down", "Home", "End",
  "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+z", "ctrl+l", "ctrl+t", "ctrl+w", "ctrl+r", "ctrl+f", "F5",
]);

export type ScreenInput =
  | { kind: "tap"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { kind: "scroll"; x: number; y: number; dir: "up" | "down"; amount?: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

const frac = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Validates an input action. Positions are fractions of the screen (0..1), so any image size works. */
export function parseInput(b: any): ScreenInput {
  switch (b?.kind) {
    case "tap":
      if (!frac(b.x) || !frac(b.y)) throw httpError(400, "x and y must be between 0 and 1");
      return { kind: "tap", x: b.x, y: b.y, button: b.button === "right" ? "right" : "left", double: b.double === true };
    case "scroll":
      if (!frac(b.x) || !frac(b.y)) throw httpError(400, "x and y must be between 0 and 1");
      if (b.dir !== "up" && b.dir !== "down") throw httpError(400, "dir must be up or down");
      return { kind: "scroll", x: b.x, y: b.y, dir: b.dir, amount: Math.max(1, Math.min(15, Math.floor(Number(b.amount) || 3))) };
    case "text": {
      // Printable text only: control characters would act as keys.
      const text = typeof b.text === "string" ? b.text.replace(/[\p{C}]/gu, "") : "";
      if (!text) throw httpError(400, "Nothing to type");
      if (text.length > 1000) throw httpError(400, "At most 1000 characters at a time");
      return { kind: "text", text };
    }
    case "key":
      if (typeof b.key !== "string" || !KEYS.has(b.key)) throw httpError(400, "That key isn't allowed");
      return { kind: "key", key: b.key };
    default:
      throw httpError(400, "Unknown input");
  }
}

export async function sendInput(i: ScreenInput) {
  if (displayState()?.holder !== "owner") throw httpError(409, "Take control of the screen first");
  if (i.kind === "text") return exec("xdotool", ["type", "--delay", "12", "--", i.text]);
  if (i.kind === "key") return exec("xdotool", ["key", "--clearmodifiers", i.key]);
  const { w, h } = await screenSize();
  const x = String(Math.round(i.x * (w - 1))), y = String(Math.round(i.y * (h - 1)));
  if (i.kind === "tap") {
    const args = ["mousemove", "--sync", x, y, "click"];
    if (i.double) args.push("--repeat", "2");
    return exec("xdotool", [...args, i.button === "right" ? "3" : "1"]);
  }
  return exec("xdotool", ["mousemove", "--sync", x, y, "click", "--repeat", String(i.amount ?? 3), i.dir === "up" ? "4" : "5"]);
}

export function registerScreenRoutes(app: FastifyInstance) {
  app.get("/api/screen/snapshot", async (req, reply) => {
    const w = Math.floor(Number((req.query as any).w ?? 1280));
    const width = Number.isFinite(w) ? Math.max(320, Math.min(1920, w)) : 1280;
    let jpeg: Buffer;
    try { jpeg = await snapshot(width); } catch { throw httpError(503, "The shared screen isn't running"); }
    return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpeg);
  });
  app.post("/api/screen/input", async (req) => {
    const input = parseInput(req.body);
    try { await sendInput(input); } catch (e: any) { throw e.statusCode ? e : httpError(502, "The screen didn't take the input"); }
    return { ok: true };
  });
}
