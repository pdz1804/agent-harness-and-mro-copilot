import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList } from "react";
import { StickToBottomController } from "../lib/stick-to-bottom";

/** Attach `ref` to the scrollable element. `contentDeps` are the values that
 * change when the content grows (messages, streamed text); `resetKey` changes
 * when a different conversation is shown. Returns whether the view is
 * currently following the newest content, and a jump function for the
 * "Jump to latest" pill. */
export function useStickToBottom<T extends HTMLElement>(contentDeps: DependencyList, resetKey: unknown) {
  const ref = useRef<T>(null);
  const controller = useRef<StickToBottomController | null>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctrl = new StickToBottomController(el, setFollowing);
    controller.current = ctrl;
    const onScroll = () => ctrl.handleScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      controller.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    controller.current?.contentChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, contentDeps);

  useEffect(() => {
    controller.current?.reset();
  }, [resetKey]);

  const jumpToLatest = useCallback(() => controller.current?.jumpToLatest(), []);

  return { ref, following, jumpToLatest };
}
