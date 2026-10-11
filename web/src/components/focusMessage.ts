/**
 * Showing a message from a link (a roadmap step's question, …). Navigating to the URL you're already
 * on fires nothing, and a conversation scrolls to a linked message only when the link first opens;
 * so links go through openMessage(): same URL → the open conversation is asked directly to scroll
 * to the message again and flash it; another URL → navigate as usual (the conversation focuses it).
 */
const EVENT = "agentbox:focus-message";

export function openMessage(href: string, messageId: string | null) {
  if (location.hash === href) {
    if (messageId) window.dispatchEvent(new CustomEvent(EVENT, { detail: messageId }));
    return;
  }
  location.hash = href;
}

/** A conversation listens: `cb(messageId)` for every request, including repeats. */
export function onFocusRequest(cb: (messageId: string) => void) {
  const h = (e: Event) => cb(String((e as CustomEvent).detail));
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
