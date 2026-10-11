import { createContext } from "react";

/** "Insert in terminal" for any command in the Setup workspace (null outside it). */
export const InsertCtx = createContext<((text: string) => void) | null>(null);

/** One line, no control characters: inserting must never run anything (the owner presses Enter). */
export function insertable(text: string) {
  return text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
}
