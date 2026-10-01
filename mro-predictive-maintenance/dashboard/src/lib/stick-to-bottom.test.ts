import { describe, expect, it, vi } from "vitest";
import {
  NEAR_BOTTOM_PX,
  StickToBottomController,
  distanceFromBottom,
  isNearBottom,
  nextFollowing,
  type ScrollMetrics,
} from "./stick-to-bottom";

/** A fake scroll container: scrollTop is clamped like a real element. */
function fakeEl(scrollHeight: number, clientHeight: number, scrollTop = 0): ScrollMetrics {
  let top = scrollTop;
  const el = {
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));
    },
  };
  return el;
}

describe("distanceFromBottom / isNearBottom", () => {
  it("is 0 when pinned to the bottom", () => {
    expect(distanceFromBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(0);
  });

  it("is never negative when content is shorter than the viewport", () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(0);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true);
  });

  it("treats within the threshold as near, beyond as not", () => {
    const near = { scrollTop: 600 - NEAR_BOTTOM_PX, scrollHeight: 1000, clientHeight: 400 };
    const far = { scrollTop: 600 - NEAR_BOTTOM_PX - 1, scrollHeight: 1000, clientHeight: 400 };
    expect(isNearBottom(near)).toBe(true);
    expect(isNearBottom(far)).toBe(false);
  });
});

describe("nextFollowing", () => {
  it("stops following when the user scrolls up away from the bottom", () => {
    const m = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
    expect(nextFollowing(true, m, 600)).toBe(false);
  });

  it("keeps following when content grows without the user scrolling (scrollTop unchanged)", () => {
    // Was pinned at 600; 200px of new content arrives, scrollTop stays 600.
    const m = { scrollTop: 600, scrollHeight: 1200, clientHeight: 400 };
    expect(nextFollowing(true, m, 600)).toBe(true);
  });

  it("does not resume following on a downward scroll that is still far from the bottom", () => {
    const m = { scrollTop: 400, scrollHeight: 1000, clientHeight: 400 };
    expect(nextFollowing(false, m, 300)).toBe(false);
  });

  it("resumes following when the user scrolls back to the bottom", () => {
    const m = { scrollTop: 590, scrollHeight: 1000, clientHeight: 400 };
    expect(nextFollowing(false, m, 400)).toBe(true);
  });

  it("ignores sub-slack upward jitter at the bottom", () => {
    const m = { scrollTop: 598, scrollHeight: 1000, clientHeight: 400 };
    expect(nextFollowing(true, m, 600)).toBe(true);
  });
});

describe("StickToBottomController", () => {
  it("pins to the bottom on content change while following (streaming tokens)", () => {
    const el = fakeEl(1000, 400, 600);
    const ctrl = new StickToBottomController(el);
    ctrl.reset();
    el.scrollTop = 600;
    (el as { scrollHeight: number }).scrollHeight = 1300;
    ctrl.contentChanged();
    expect(el.scrollTop).toBe(900);
  });

  it("does NOT move the view when the user has scrolled up", () => {
    const el = fakeEl(1000, 400);
    const onChange = vi.fn();
    const ctrl = new StickToBottomController(el, onChange);
    ctrl.reset(); // pinned at 600
    el.scrollTop = 200; // user scrolls up
    ctrl.handleScroll();
    expect(ctrl.following).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);

    (el as { scrollHeight: number }).scrollHeight = 1400; // more tokens stream in
    ctrl.contentChanged();
    expect(el.scrollTop).toBe(200);
  });

  it("jumpToLatest resumes following and pins to the newest content", () => {
    const el = fakeEl(1000, 400);
    const onChange = vi.fn();
    const ctrl = new StickToBottomController(el, onChange);
    ctrl.reset();
    el.scrollTop = 100;
    ctrl.handleScroll();
    expect(ctrl.following).toBe(false);

    (el as { scrollHeight: number }).scrollHeight = 1500;
    ctrl.jumpToLatest();
    expect(ctrl.following).toBe(true);
    expect(el.scrollTop).toBe(1100);
    expect(onChange).toHaveBeenLastCalledWith(true);

    // And it keeps following afterwards.
    (el as { scrollHeight: number }).scrollHeight = 1700;
    ctrl.contentChanged();
    expect(el.scrollTop).toBe(1300);
  });

  it("resumes following when the user scrolls back down to the bottom by hand", () => {
    const el = fakeEl(1000, 400);
    const ctrl = new StickToBottomController(el);
    ctrl.reset();
    el.scrollTop = 100;
    ctrl.handleScroll();
    expect(ctrl.following).toBe(false);
    el.scrollTop = 600;
    ctrl.handleScroll();
    expect(ctrl.following).toBe(true);
  });

  it("only notifies on actual following changes", () => {
    const el = fakeEl(1000, 400);
    const onChange = vi.fn();
    const ctrl = new StickToBottomController(el, onChange);
    ctrl.reset();
    ctrl.handleScroll();
    ctrl.handleScroll();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reset re-follows after switching conversations", () => {
    const el = fakeEl(1000, 400);
    const ctrl = new StickToBottomController(el);
    ctrl.reset();
    el.scrollTop = 50;
    ctrl.handleScroll();
    expect(ctrl.following).toBe(false);
    ctrl.reset();
    expect(ctrl.following).toBe(true);
    expect(el.scrollTop).toBe(600);
  });
});
