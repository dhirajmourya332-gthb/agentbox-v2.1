import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { api } from "../api.ts";
import { Icon, Spinner } from "./ui.tsx";

/**
 * Images attached to a message or new task: pasted (⌘V), dropped, or picked. Each uploads right
 * away to the VM (/work/uploads), so sending only passes the saved paths.
 */

type Item = { id: string; name: string; preview: string; path?: string; error?: string };
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX = 10 * 1024 * 1024;

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the image"));
    r.readAsDataURL(f);
  });

export function useAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => live.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  function add(files: File[]) {
    const images = files.filter((f) => TYPES.includes(f.type));
    for (const f of images) {
      const id = Math.random().toString(36).slice(2);
      const name = f.name && f.name !== "image.png" ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${f.type.split("/")[1]}`;
      const item: Item = { id, name, preview: URL.createObjectURL(f) };
      if (f.size > MAX) item.error = "Over 10 MB";
      setItems((s) => [...s, item].slice(0, 10));
      if (item.error) continue;
      toBase64(f)
        .then((data) => api.upload(name, f.type, data))
        .then((r) => setItems((s) => s.map((i) => (i.id === id ? { ...i, path: r.path } : i))))
        .catch((e) => setItems((s) => s.map((i) => (i.id === id ? { ...i, error: e.message || "Upload failed" } : i))));
    }
    return images.length;
  }
  const remove = (id: string) =>
    setItems((s) => {
      const gone = s.find((i) => i.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      return s.filter((i) => i.id !== id);
    });
  const clear = () => {
    items.forEach((i) => URL.revokeObjectURL(i.preview));
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
      // Keep a normal text paste working; only take over when there are images.
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

/** Thumbnails of what's attached, each removable. */
export function AttachmentStrip({ a }: { a: Attachments }) {
  if (!a.items.length) return null;
  return (
    <div className="attach-strip" aria-label="Attached images">
      {a.items.map((i) => (
        <div key={i.id} className={`attach-thumb${i.error ? " failed" : ""}`} title={i.error ? `${i.name}: ${i.error}` : i.name}>
          <img src={i.preview} alt={i.name} />
          {!i.path && !i.error && <span className="attach-busy"><Spinner /></span>}
          {i.error && <span className="attach-err">!</span>}
          <button className="attach-x" aria-label={`Remove ${i.name}`} onClick={() => a.remove(i.id)}><Icon name="x" size={10} /></button>
        </div>
      ))}
    </div>
  );
}

/** The paperclip-style button: opens a file picker for images. */
export function AttachButton({ a }: { a: Attachments }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="icon-btn attach-btn" aria-label="Attach images" title="Attach images (or paste / drop them)"
        onClick={() => input.current?.click()}>
        <Icon name="image" size={15} />
      </button>
      <input ref={input} type="file" accept={TYPES.join(",")} multiple hidden
        onChange={(e) => { a.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </>
  );
}
