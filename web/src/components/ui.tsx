import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { AgentStatus } from "../api.ts";

// Stroke icons, 16px grid (docs/UI-DESIGN.md: inline SVG, never emoji).
const PATHS: Record<string, string> = {
  screen: "M2.5 3h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM5.5 14.5h5M8 12v2.5",
  terminal: "M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM4.5 6l2 2-2 2M8.5 10.5h3",
  pulse: "M1.5 8h3L6 4l3 8 1.5-4h4",
  team: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM1.5 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5M11 7.5a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.7.2 3 1.4 3 3.5",
  plus: "M8 3v10M3 8h10",
  stop: "M4.5 4.5h7v7h-7z",
  send: "M2.5 8 13.5 2.5 10 13.5 7.5 8.5 2.5 8ZM7.5 8.5 13.5 2.5",
  panel: "M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM10 2.5v11",
  chevron: "M6 4l4 4-4 4",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.5 6.5 12 13 4.5",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  shell: "M3 5l3 3-3 3M8 11h5",
  edit: "M10.5 2.5l3 3-7.5 7.5H3v-3l7.5-7.5Z",
  read: "M2 3.5h4.5A1.5 1.5 0 0 1 8 5v8.5a1 1 0 0 0-1-1H2v-9ZM14 3.5H9.5A1.5 1.5 0 0 0 8 5v8.5a1 1 0 0 1 1-1h5v-9Z",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM14 14l-3.5-3.5",
  browser: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM1.5 8h13M8 1.5c1.8 1.9 2.6 4 2.6 6.5S9.8 12.6 8 14.5M8 1.5C6.2 3.4 5.4 5.5 5.4 8s.8 4.6 2.6 6.5",
  web: "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
  plan: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5",
  agent: "M8 2v2M4.5 6.5h7a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1ZM6.5 9.5v.5M9.5 9.5v.5",
  tool: "M10 2.5a3.5 3.5 0 0 0-3.3 4.6L2.5 11.3v2.2h2.2l4.2-4.2A3.5 3.5 0 1 0 10 2.5Z",
  meta: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM14 14l-3.5-3.5",
  back: "M10 4 6 8l4 4",
  skill: "M8 1.5l1.6 3.9 4.2.4-3.2 2.8 1 4.1L8 10.5l-3.6 2.2 1-4.1-3.2-2.8 4.2-.4L8 1.5Z",
  delegate: "M2 8h9M8 4.5 11.5 8 8 11.5M13.5 3v10",
  board: "M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v9h-3z",
  sparkle: "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.tool} />
    </svg>
  );
}

export function Avatar({ name, color, size = 24 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.46) }} aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  );
}

const STATUS_WORD: Record<AgentStatus, string> = { idle: "Idle", working: "Working", limited: "Limited", error: "Error" };

export function StatusGlyph({ status, withLabel = false }: { status: AgentStatus; withLabel?: boolean }) {
  return (
    <span className="status" title={STATUS_WORD[status]}>
      <span className={`glyph ${status}`} />
      {withLabel ? STATUS_WORD[status] : <span className="sr-only">{STATUS_WORD[status]}</span>}
    </span>
  );
}

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`prose${streaming ? " cursor" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Spinner() {
  return <span className="glyph working" aria-hidden="true" />;
}

export function relTime(iso: string) {
  const d = new Date(iso);
  const same = d.toDateString() === new Date().toDateString();
  return same
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function duration(fromIso: string, toIso?: string | null) {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
