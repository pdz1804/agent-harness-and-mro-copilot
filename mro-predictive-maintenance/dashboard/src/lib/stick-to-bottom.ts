/** Stick-to-bottom scroll model for streaming chat panels.
 *
 * Rules (the whole point of the module):
 *  - while "following", every content change re-pins the view to the bottom;
 *  - the moment the user scrolls UP (scrollTop decreases and they are no
 *    longer at the bottom) following stops, so streaming tokens never yank
 *    them back down while they read history;
 *  - scrolling back to within NEAR_BOTTOM_PX of the bottom, or calling
 *    `jumpToLatest()`, resumes following.
 *
 * Content growth alone never fires a scroll event and never lowers
 * scrollTop, so it cannot be mistaken for a user scroll. The controller is
 * DOM-free (it only needs scroll metrics) so it is unit-testable in node. */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Within this distance of the bottom counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 32;
/** An upward scroll beyond this slack un-follows; sub-pixel jitter does not. */
export const UNFOLLOW_SLACK_PX = 4;

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

export function isNearBottom(m: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/** Pure transition applied on every scroll event. */
export function nextFollowing(prevFollowing: boolean, m: ScrollMetrics, lastScrollTop: number): boolean {
  const distance = distanceFromBottom(m);
  const scrolledUp = m.scrollTop < lastScrollTop;
  if (scrolledUp && distance > UNFOLLOW_SLACK_PX) return false;
  if (distance <= NEAR_BOTTOM_PX) return true;
  return prevFollowing;
}

export class StickToBottomController {
  following = true;
  private lastScrollTop = 0;

  constructor(
    private readonly el: ScrollMetrics,
    private readonly onFollowingChange: (following: boolean) => void = () => {},
  ) {}

  private set(following: boolean): void {
    if (following !== this.following) {
      this.following = following;
      this.onFollowingChange(following);
    }
  }

  /** Call from the element's scroll listener. */
  handleScroll(): void {
    this.set(nextFollowing(this.following, this.el, this.lastScrollTop));
    this.lastScrollTop = this.el.scrollTop;
  }

  /** Call after the rendered content changed (new message, streamed token). */
  contentChanged(): void {
    if (!this.following) return;
    this.pin();
  }

  /** Initial placement of a freshly loaded conversation: scroll to `top`
   * (clamped) and follow only if that is the bottom. Used to show the
   * latest prompt from its first line instead of clipping it at the top edge. */
  anchorTo(top: number): void {
    const max = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    this.el.scrollTop = Math.min(max, Math.max(0, top));
    this.lastScrollTop = this.el.scrollTop;
    this.set(isNearBottom(this.el));
  }

  /** "Jump to latest" pill: resume following and pin to the bottom. */
  jumpToLatest(): void {
    this.set(true);
    this.pin();
  }

  /** A different conversation is shown: follow from the bottom again. */
  reset(): void {
    this.lastScrollTop = 0;
    this.set(true);
    this.pin();
  }

  private pin(): void {
    this.el.scrollTop = this.el.scrollHeight;
    this.lastScrollTop = this.el.scrollTop;
  }
}
