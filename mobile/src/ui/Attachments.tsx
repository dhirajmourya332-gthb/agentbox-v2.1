import * as ImagePicker from "expo-image-picker";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { base64ToBase64url, fromBase64url } from "../crypto/encoding";

/**
 * Images attached to a message or new task. Each is uploaded right away (POST uploads, base64
 * JSON like the portal), so sending only passes the saved paths. Uses the system photo picker,
 * which needs no storage permission on current Android.
 */

type Item = { id: string; name: string; preview: string; path?: string; error?: string };
const MAX = 10 * 1024 * 1024;
const MAX_ITEMS = 10;

/** Trust the bytes, not the picker's metadata: sniff the type from the base64 header. */
export function sniffImageType(b64: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  let h: Uint8Array;
  try { h = fromBase64url(base64ToBase64url(b64.slice(0, 16))); } catch { return null; }
  const ascii = (from: number, to: number) => String.fromCharCode(...h.slice(from, to));
  if (h[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;

export function useAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);

  async function pick() {
    const room = MAX_ITEMS - items.length;
    if (room <= 0) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: room,
      base64: true,
      exif: false,
      quality: 0.85,
    });
    if (res.canceled) return;
    for (const a of res.assets.slice(0, room)) {
      const id = `a${seq.current++}`;
      const b64 = a.base64 ?? "";
      const type = sniffImageType(b64);
      const size = Math.floor((b64.length * 3) / 4);
      const name = `phone-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}-${id}.${type ? EXT[type] : "img"}`;
      const item: Item = { id, name, preview: a.uri };
      if (!b64) item.error = "Couldn't read the image";
      else if (!type) item.error = "Only PNG, JPEG, GIF and WebP";
      else if (size > MAX) item.error = "Over 10 MB";
      setItems((s) => [...s, item].slice(0, MAX_ITEMS));
      if (item.error || !type) continue;
      api.upload(name, type, b64)
        .then((r) => setItems((s) => s.map((i) => (i.id === id ? { ...i, path: r.path } : i))))
        .catch((e: unknown) => setItems((s) => s.map((i) => (i.id === id ? { ...i, error: e instanceof Error ? e.message : "Upload failed" } : i))));
    }
  }

  return {
    items,
    paths: items.filter((i) => i.path).map((i) => i.path!),
    uploading: items.some((i) => !i.path && !i.error),
    pick,
    remove: (id: string) => setItems((s) => s.filter((i) => i.id !== id)),
    clear: () => setItems([]),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;
