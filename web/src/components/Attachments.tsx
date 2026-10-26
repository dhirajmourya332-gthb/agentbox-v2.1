import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { api } from "../api.ts";
import { Icon, Spinner } from "./ui.tsx";

/**
 * Files attached to a message or new task (images, PDFs, Markdown, spreadsheets, documents…):
 * pasted (⌘V), dropped, or picked. Each uploads right away to the VM (/work/uploads), so sending
 * only passes the saved paths. Images get a thumbnail; other files a chip with their name.
 */

/** preview: an object URL for images only. */
type Item = { id: string; name: string; preview: string | null; path?: string; error?: string };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX = 20 * 1024 * 1024;
const MAX_FILES = 10;

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(f);
  });

export function useAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const live = useRef(items);
  live.current = items;
  const revoke = (i: Item) => { if (i.preview) URL.revokeObjectURL(i.preview); };
  useEffect(() => () => live.current.forEach(revoke), []);

  function add(files: File[]) {
    const room = MAX_FILES - live.current.length;
    const taken = files.filter((f) => f.size > 0 || f.name).slice(0, Math.max(room, 0));
    for (const f of taken) {
      const id = Math.random().toString(36).slice(2);
      const image = IMAGE_TYPES.includes(f.type);
      const name = f.name && f.name !== "image.png" ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${image ? f.type.split("/")[1] : "bin"}`;
      const item: Item = { id, name, preview: image ? URL.createObjectURL(f) : null };
      if (f.size > MAX) item.error = "Over 20 MB";
      else if (!f.size) item.error = "Empty file";
      setItems((s) => [...s, item].slice(0, MAX_FILES));
      if (item.error) continue;
      toBase64(f)
        .then((data) => api.upload(name, f.type, data))
        .then((r) => setItems((s) => s.map((i) => (i.id === id ? { ...i, path: r.path } : i))))
        .catch((e) => setItems((s) => s.map((i) => (i.id === id ? { ...i, error: e.message || "Upload failed" } : i))));
    }
    return taken.length;
  }
  const remove = (id: string) =>
    setItems((s) => {
      const gone = s.find((i) => i.id === id);
      if (gone) revoke(gone);
      return s.filter((i) => i.id !== id);
    });
  const clear = () => {
    items.forEach(revoke);
    setItems([]);
  };

  return {
    items,
    paths: items.filter((i) => i.path).map((i) => i.path!),
    uploading: items.some((i) => !i.path && !i.error),
    failed: items.some((i) => i.error),
    dragging,
    add,
    remove,
    clear,
    /** Restore after a failed send. */
    restore: (saved: Item[]) => setItems(saved),
    onPaste: (e: ClipboardEvent) => {
      const files = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean) as File[];
      // Keep a normal text paste working; only take over when there are files.
      if (add(files) && !e.clipboardData.getData("text/plain")) e.preventDefault();
    },
    dropProps: {
      onDragOver: (e: DragEvent) => {
        if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setDragging(true); }
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        add([...e.dataTransfer.files]);
      },
    },
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** What's attached, each removable: a thumbnail for an image, a chip with the name for any other file. */
export function AttachmentStrip({ a }: { a: Attachments }) {
  if (!a.items.length) return null;
  return (
    <div className="attach-strip" aria-label="Attached files">
      {a.items.map((i) => (
        <div key={i.id} className={`attach-thumb${i.preview ? "" : " file"}${i.error ? " failed" : ""}`} title={i.error ? `${i.name}: ${i.error}` : i.name}>
          {i.preview ? <img src={i.preview} alt={i.name} /> : (
            <span className="attach-file">
              <span className="attach-ext">{(i.name.split(".").pop() ?? "").slice(0, 4) || "file"}</span>
              <span className="attach-name">{i.name}</span>
            </span>
          )}
          {!i.path && !i.error && <span className="attach-busy"><Spinner /></span>}
          {i.error && <span className="attach-err">!</span>}
          <button className="attach-x" aria-label={`Remove ${i.name}`} onClick={() => a.remove(i.id)}><Icon name="x" size={10} /></button>
        </div>
      ))}
    </div>
  );
}

/** The paperclip button: opens a file picker for any kind of file. */
export function AttachButton({ a }: { a: Attachments }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="icon-btn attach-btn" aria-label="Attach files" title="Attach files: images, PDFs, docs, spreadsheets… up to 20 MB each (or paste / drop them)"
        onClick={() => input.current?.click()}>
        <Icon name="clip" size={15} />
      </button>
      <input ref={input} type="file" multiple hidden
        onChange={(e) => { a.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </>
  );
}
