import { useColorScheme } from "react-native";

export type Palette = {
  bg: string; surface: string; surface2: string; border: string; text: string; muted: string;
  accent: string; accentText: string; ok: string; warn: string; bad: string; code: string;
};

const light: Palette = {
  bg: "#f7f7f5", surface: "#ffffff", surface2: "#f0f0ed", border: "#e2e2dd", text: "#1b1b18", muted: "#6b6b63",
  accent: "#2f5bd3", accentText: "#ffffff", ok: "#1f8a4c", warn: "#b7791f", bad: "#c53030", code: "#f0f0ed",
};
const dark: Palette = {
  bg: "#121211", surface: "#1c1c1a", surface2: "#262624", border: "#33332f", text: "#ecece8", muted: "#a0a098",
  accent: "#7d9cf0", accentText: "#0d0d0c", ok: "#4cc27e", warn: "#e0a84a", bad: "#f07070", code: "#262624",
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export const isDark = (p: Palette) => p === dark;

export function statusColor(p: Palette, status: string): string {
  switch (status) {
    case "working": case "running": return p.accent;
    case "queued": return p.warn;
    case "limited": return p.warn;
    case "error": case "failed": return p.bad;
    case "done": return p.ok;
    default: return p.muted;
  }
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 0) {
    const m = Math.round(-s / 60);
    if (m < 1) return "in under a minute";
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60);
    return h < 24 ? `in ${h} h ${m % 60} min` : `in ${Math.floor(h / 24)} d`;
  }
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
