import fs from "node:fs";
import path from "node:path";
import { newId } from "./db.ts";
import { WORK_ROOT } from "./agents.ts";

/**
 * Files the owner pastes or attaches in a chat or new task: images, PDFs, Markdown, spreadsheets,
 * documents, anything up to 20 MB. They're saved in the VM under /work/uploads so agents can open
 * them and reuse them, e.g. attach one to a GitHub issue. In messages, images are stored as markdown
 * images (the UI shows them) and other files as links; agents get the paths, with how to open each.
 */

export const UPLOAD_ROOT = path.join(WORK_ROOT, "uploads");
export const LIMITS = { bytes: 20 * 1024 * 1024, files: 10 };
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const FROM_TYPE: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf" };

export const isImage = (p: string) => IMAGE_EXT.has(path.extname(p).toLowerCase());

export function saveUpload(input: { name?: string; type?: string; data?: string }) {
  const name = String(input.name ?? "").trim();
  // The file's own extension (kept so it opens as what it is), else one from its type, else none.
  const own = path.extname(name).toLowerCase();
  const ext = /^\.[a-z0-9]{1,10}$/.test(own) ? own : FROM_TYPE[String(input.type ?? "").toLowerCase()] ?? "";
  const bytes = Buffer.from(String(input.data ?? ""), "base64");
  if (!bytes.length) throw new Error("The file is empty");
  if (bytes.length > LIMITS.bytes) throw new Error("Files can be at most 20 MB");
  const dir = path.join(UPLOAD_ROOT, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const base = (ext && name.toLowerCase().endsWith(ext) ? name.slice(0, -ext.length) : name)
    .replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60) || "file";
  const file = path.join(dir, `${base}-${newId().slice(0, 8)}${ext}`);
  fs.writeFileSync(file, bytes);
  return { path: file, name: path.basename(file), size: bytes.length, image: isImage(file) };
}

/** Attached file paths, checked: real files inside /work/uploads only. */
export function checkAttachments(files: unknown): string[] {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.length > LIMITS.files) throw new Error(`Attach at most ${LIMITS.files} files`);
  if (files.length === 0) return [];
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); // a fresh install has no uploads yet
  const root = fs.realpathSync(UPLOAD_ROOT);
  return files.map((p) => {
    let real: string;
    try { real = fs.realpathSync(String(p)); } catch { throw new Error("An attached file is missing; attach it again"); }
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error("That attachment isn't an uploaded file");
    return real;
  });
}

const fileUrl = (p: string) => `/api/file?path=${encodeURIComponent(p)}`;

/** What the conversation shows: the text, then the images, then the other files as links. */
export function displayWithAttachments(text: string, files: string[]) {
  const pics = files.filter(isImage).map((p) => `![${path.basename(p)}](${fileUrl(p)})`).join(" ");
  const docs = files.filter((p) => !isImage(p)).map((p) => `[📎 ${path.basename(p)}](${fileUrl(p)})`).join("  \n");
  return [text, pics, docs].filter(Boolean).join("\n\n");
}

// An attached image (![…](…)) or file ([📎 …](…)) as stored in a message.
const ATTACHED_MD = /!?\[[^\]]*\]\(\/api\/file\?path=([^)\s]+)\)/g;

/** How an agent opens a file of this kind. */
function howToOpen(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (isImage(p)) return "image: open it with the Read tool to see it";
  if (ext === ".pdf") return "PDF: the Read tool reads it (in page ranges for long ones)";
  if ([".xlsx", ".xlsm", ".xls", ".ods"].includes(ext)) return "spreadsheet: read it with Python (openpyxl or pandas); don't change the original";
  if ([".docx", ".odt", ".rtf"].includes(ext)) return "document: extract its text with Python (python-docx) or pandoc";
  if ([".pptx", ".odp"].includes(ext)) return "slides: extract their text with Python (python-pptx)";
  if ([".zip", ".tar", ".gz", ".tgz", ".7z"].includes(ext)) return "archive: unpack a copy in your scratch folder to look inside";
  return "open it with the Read tool";
}

/** What an agent reads: attached images and files become paths it can open, with how. */
export function attachmentsForAgent(content: string) {
  const paths: string[] = [];
  const text = content.replace(ATTACHED_MD, (_, p) => {
    paths.push(decodeURIComponent(p));
    return "";
  }).trim();
  if (!paths.length) return content;
  return `${text}${text ? "\n\n" : ""}[Attached by the owner (${paths.length} file${paths.length > 1 ? "s" : ""}):]\n${paths.map((p) => `- ${p} (${howToOpen(p)})`).join("\n")}`;
}
