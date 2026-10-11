import fs from "node:fs";
import path from "node:path";
import { newId } from "./db.ts";
import { WORK_ROOT } from "./agents.ts";

/**
 * Images the owner pastes or attaches in a chat or new task. They're saved in the VM under
 * /work/uploads so agents can open them (the Read tool shows images) and reuse them, e.g. attach
 * one to a GitHub issue. In messages they're stored as markdown images, which the UI renders.
 */

export const UPLOAD_ROOT = path.join(WORK_ROOT, "uploads");
const MAX_BYTES = 10 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

export function saveUpload(input: { name?: string; type?: string; data?: string }) {
  const ext = EXT[String(input.type ?? "").toLowerCase()];
  if (!ext) throw new Error("Only PNG, JPEG, GIF and WebP images can be attached");
  const bytes = Buffer.from(String(input.data ?? ""), "base64");
  if (!bytes.length) throw new Error("The image is empty");
  if (bytes.length > MAX_BYTES) throw new Error("Images can be at most 10 MB");
  const dir = path.join(UPLOAD_ROOT, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const base = String(input.name ?? "image").replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
  const file = path.join(dir, `${base}-${newId().slice(0, 8)}${ext}`);
  fs.writeFileSync(file, bytes);
  return { path: file, name: path.basename(file), size: bytes.length };
}

/** Attached image paths, checked: real files inside /work/uploads only. */
export function checkImages(images: unknown): string[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > 10) throw new Error("Attach at most 10 images");
  if (images.length === 0) return [];
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); // a fresh install has no uploads yet
  const root = fs.realpathSync(UPLOAD_ROOT);
  return images.map((p) => {
    let real: string;
    try { real = fs.realpathSync(String(p)); } catch { throw new Error("An attached image is missing; attach it again"); }
    if (!real.startsWith(root + path.sep) || !EXT[`image/${path.extname(real).slice(1).replace("jpg", "jpeg")}`]) {
      throw new Error("That attachment isn't an uploaded image");
    }
    return real;
  });
}

/** What the conversation shows: the text, then the images. */
export function displayWithImages(text: string, images: string[]) {
  const pics = images.map((p) => `![${path.basename(p)}](/api/file?path=${encodeURIComponent(p)})`).join(" ");
  return [text, pics].filter(Boolean).join("\n\n");
}

const IMAGE_MD = /!\[[^\]]*\]\(\/api\/file\?path=([^)\s]+)\)/g;

/** What an agent reads: markdown images become file paths it can open with the Read tool. */
export function imagesForAgent(content: string) {
  const paths: string[] = [];
  const text = content.replace(IMAGE_MD, (_, p) => {
    paths.push(decodeURIComponent(p));
    return "";
  }).trim();
  if (!paths.length) return content;
  return `${text}${text ? "\n\n" : ""}[Attached image${paths.length > 1 ? "s" : ""} from the owner. Open ${paths.length > 1 ? "each" : "it"} with the Read tool to see ${paths.length > 1 ? "them" : "it"}:]\n${paths.map((p) => `- ${p}`).join("\n")}`;
}
