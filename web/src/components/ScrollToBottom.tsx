import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "./ui.tsx";

/**
 * "Jump to latest", bottom-centre of a conversation, once the reader has scrolled away from the
 * newest message; it says "New messages" when more arrived meanwhile. Rendered as the scroller's last
 * child: a zero-height sticky dock, so it floats over the content without taking space.
 */
export function ScrollToBottom({ scroller, onJump }: { scroller: RefObject<HTMLElement | null>; onJump?: () => void }) {
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const height = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      const off = el.scrollHeight - el.scrollTop - el.clientHeight > 240;
      if (off && el.scrollHeight > height.current + 4 && height.current) setFresh(true);
      if (!off) setFresh(false);
      height.current = el.scrollHeight;
      setAway(off);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    // New content changes the height without a scroll event.
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, [scroller]);
  if (!away) return null;
  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    onJump?.();
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  return (
    <div className="to-bottom-dock">
      <button className={`to-bottom${fresh ? " fresh" : ""}`} onClick={jump} aria-label="Scroll to the latest message">
        <Icon name="chevron" size={13} />{fresh ? "New messages" : "Jump to latest"}
      </button>
    </div>
  );
}
