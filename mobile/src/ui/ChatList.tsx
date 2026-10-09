import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactElement, type Ref } from "react";
import {
  FlatList, Pressable, StyleSheet, Text, View, type ListRenderItem, type NativeScrollEvent, type NativeSyntheticEvent,
} from "react-native";
import { usePalette } from "./theme";

/**
 * The conversation timeline shared by rooms and groups: an inverted list (newest first, so the
 * bottom of the screen is scroll offset 0 and a fresh open starts at the latest message).
 *
 * Scrolling the way chat apps do:
 * - Near the bottom (within NEAR px of offset 0), new content follows: the list stays pinned to
 *   the newest message (`autoscrollToTopThreshold`; "top" is the visual bottom when inverted).
 * - Scrolled up, nothing moves: `maintainVisibleContentPosition` keeps the first visible row where
 *   it is while rows are added or grow below it (new messages, streaming replies, "working…" rows).
 *   A "New messages" pill counts what arrived; tapping it (or scrolling down) clears it.
 * - A message the user just sent always brings the view to the bottom.
 */

const NEAR = 80; // px from the bottom that still counts as "at the bottom"
const FAR = 600; // scrolled up this far with nothing new: offer a plain "jump to latest" button

export type ChatListHandle = { scrollToBottom: (animated?: boolean) => void };

export function ChatList<R extends { id: string }>({
  ref, data, renderItem, footer, isMessage, isMine, resetKey,
}: {
  ref?: Ref<ChatListHandle>;
  /** Newest first. */
  data: R[];
  renderItem: ListRenderItem<R>;
  /** Shown above the oldest row (the list is inverted). */
  footer?: ReactElement | null;
  /** Rows that count as messages for the unread pill (not "working…" placeholders). */
  isMessage: (r: R) => boolean;
  /** Rows the user wrote themselves: these always scroll to the bottom. */
  isMine: (r: R) => boolean;
  /** Changing it (e.g. a member filter) resets the unread tracking without counting anything. */
  resetKey?: unknown;
}) {
  const p = usePalette();
  const list = useRef<FlatList<R>>(null);
  const near = useRef(true);
  const [unread, setUnread] = useState(0);
  const [far, setFar] = useState(false);

  const scrollToBottom = useCallback((animated = true) => {
    list.current?.scrollToOffset({ offset: 0, animated });
    setUnread(0);
  }, []);
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    near.current = y <= NEAR;
    if (near.current) setUnread((u) => (u ? 0 : u));
    const isFar = y > FAR;
    setFar((f) => (f === isFar ? f : isFar));
  }, []);

  // Count messages that arrived since the newest one we'd seen.
  const top = useRef<string | undefined>(undefined);
  const lastReset = useRef(resetKey);
  useEffect(() => {
    const newest = data.find(isMessage)?.id;
    const prev = top.current;
    top.current = newest;
    if (lastReset.current !== resetKey) {
      lastReset.current = resetKey;
      setUnread(0);
      return;
    }
    if (!prev || !newest || newest === prev) return;
    const idx = data.findIndex((r) => r.id === prev);
    if (idx < 0) { setUnread(0); return; }
    const fresh = data.slice(0, idx).filter(isMessage);
    if (fresh.some(isMine)) {
      // The user's own message: follow it down, wherever they were.
      requestAnimationFrame(() => scrollToBottom(true));
      return;
    }
    if (!near.current) setUnread((u) => u + fresh.length);
  }, [data, isMessage, isMine, resetKey, scrollToBottom]);

  const showPill = unread > 0;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        inverted
        data={data}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        contentContainerStyle={st.content}
        ListFooterComponent={footer}
        onScroll={onScroll}
        scrollEventThrottle={32}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: NEAR }}
      />
      {showPill ? (
        <Pressable onPress={() => scrollToBottom(true)} accessibilityRole="button"
          accessibilityLabel={`${unread} new message${unread === 1 ? "" : "s"}. Scroll to the latest`}
          style={({ pressed }) => [st.pill, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={[st.pillText, { color: p.accentText }]}>
            {unread === 1 ? "New message" : `${unread > 99 ? "99+" : unread} new messages`}  ↓
          </Text>
        </Pressable>
      ) : far ? (
        <Pressable onPress={() => scrollToBottom(true)} accessibilityRole="button" accessibilityLabel="Scroll to the latest message"
          style={({ pressed }) => [st.jump, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.7 : 1 }]}>
          <Text style={{ color: p.text, fontSize: 18, fontWeight: "600" }}>↓</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  content: { padding: 14, gap: 14 },
  pill: {
    position: "absolute", bottom: 12, alignSelf: "center", minHeight: 36, paddingHorizontal: 16, borderRadius: 18,
    alignItems: "center", justifyContent: "center", elevation: 3,
  },
  pillText: { fontSize: 14, fontWeight: "600" },
  jump: {
    position: "absolute", bottom: 12, right: 14, width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center", justifyContent: "center", elevation: 3,
  },
});
