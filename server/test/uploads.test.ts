/**
 * Attachments (uploads.ts): any file up to 20 MB, kept with its extension, shown as an image or a link,
 * and handed to agents as paths with how to open each.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/uploads.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-uploads-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\n`);
Object.assign(process.env, { AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, NO_COLOR: "1" });
const U = await import("../src/uploads.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

test("any kind of file is saved with its own extension; empty and over 20 MB are refused", () => {
  const pdf = U.saveUpload({ name: "Spec v2.pdf", type: "application/pdf", data: b64("%PDF-1.7") });
  assert.match(pdf.name, /^Spec-v2-[0-9a-f]{8}\.pdf$/);
  assert.equal(pdf.image, false);
  assert.match(U.saveUpload({ name: "BOM.xlsx", type: "", data: b64("PK") }).name, /^BOM-[0-9a-f]{8}\.xlsx$/);
  assert.match(U.saveUpload({ name: "notes.md", type: "text/markdown", data: b64("# hi") }).name, /\.md$/);
  assert.equal(U.saveUpload({ name: "image.png", type: "image/png", data: b64("x") }).image, true);
  assert.match(U.saveUpload({ name: "", type: "image/jpeg", data: b64("x") }).name, /^file-[0-9a-f]{8}\.jpg$/, "pasted: extension from the type");
  assert.match(U.saveUpload({ name: "../../etc/passwd", type: "", data: b64("x") }).path, new RegExp(`^${U.UPLOAD_ROOT}/`));
  assert.throws(() => U.saveUpload({ name: "a.txt", data: "" }), /empty/);
  assert.throws(() => U.saveUpload({ name: "a.bin", data: Buffer.alloc(U.LIMITS.bytes + 1).toString("base64") }), /20 MB/);
});

test("only real uploaded files can be attached, at most 10", () => {
  const f = U.saveUpload({ name: "a.csv", data: b64("a,b") }).path;
  assert.deepEqual(U.checkAttachments([f]), [f]);
  fs.writeFileSync(path.join(dirs.work, "secret.txt"), "x");
  assert.throws(() => U.checkAttachments([path.join(dirs.work, "secret.txt")]), /isn't an uploaded file/);
  assert.throws(() => U.checkAttachments([path.join(U.UPLOAD_ROOT, "nope.pdf")]), /missing/);
  assert.throws(() => U.checkAttachments(Array(11).fill(f)), /at most 10/);
});

test("messages show images inline and files as links; agents get each path with how to open it", () => {
  const img = U.saveUpload({ name: "shot.png", data: b64("x") }).path;
  const pdf = U.saveUpload({ name: "spec.pdf", data: b64("x") }).path;
  const xls = U.saveUpload({ name: "bom.xlsx", data: b64("x") }).path;
  const shown = U.displayWithAttachments("Look at these", [img, pdf, xls]);
  assert.match(shown, /!\[shot-[0-9a-f]{8}\.png\]\(\/api\/file\?path=/);
  assert.match(shown, /\[📎 spec-[0-9a-f]{8}\.pdf\]\(\/api\/file\?path=/);
  const agent = U.attachmentsForAgent(shown);
  assert.match(agent, /^Look at these\n\n\[Attached by the owner \(3 files\):\]/);
  assert.ok(agent.includes(`- ${img} (image: open it with the Read tool`));
  assert.ok(agent.includes(`- ${pdf} (PDF: the Read tool reads it`));
  assert.ok(agent.includes(`- ${xls} (spreadsheet: read it with Python`));
  assert.doesNotMatch(agent, /\/api\/file/);
  assert.equal(U.attachmentsForAgent("no files"), "no files");
});
