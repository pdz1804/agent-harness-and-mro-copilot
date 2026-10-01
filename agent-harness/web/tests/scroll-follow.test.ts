import { describe, expect, it } from 'vitest'
import {
  BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
  isNearBottom,
  nextFollowing,
  shouldShowJumpPill,
} from '../src/lib/scroll-follow'

const m = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight })

describe('isNearBottom / distanceFromBottom', () => {
  it('is exact at the bottom and within the threshold', () => {
    expect(distanceFromBottom(m(1400))).toBe(0)
    expect(isNearBottom(m(1400))).toBe(true)
    expect(isNearBottom(m(1400 - BOTTOM_THRESHOLD_PX))).toBe(true)
    expect(isNearBottom(m(1400 - BOTTOM_THRESHOLD_PX - 1))).toBe(false)
  })

  it('never reports a negative distance (overscroll / short content)', () => {
    expect(distanceFromBottom(m(1500))).toBe(0)
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(true)
  })
})

describe('nextFollowing', () => {
  it('keeps following while at the bottom', () => {
    expect(nextFollowing(true, m(1400), 1390)).toBe(true)
  })

  it('stops following when the user scrolls up away from the bottom', () => {
    expect(nextFollowing(true, m(1000), 1400)).toBe(false)
  })

  it('stays stopped while scrolled up, even if content keeps growing', () => {
    // scrollTop unchanged (no scroll event would fire), but if one does it must not re-enable.
    expect(nextFollowing(false, m(1000, 5000), 1000)).toBe(false)
  })

  it('does not flip off for a downward smooth-scroll in flight (far from bottom, moving down)', () => {
    expect(nextFollowing(true, m(1100), 1000)).toBe(true)
    expect(nextFollowing(false, m(1100), 1000)).toBe(false)
  })

  it('re-enables following once the user reaches the bottom again', () => {
    expect(nextFollowing(false, m(1390), 1200)).toBe(true)
  })

  it('ignores sub-pixel jitter as an upward scroll', () => {
    expect(nextFollowing(true, m(1000), 1001)).toBe(true)
  })
})

describe('shouldShowJumpPill', () => {
  it('shows only when active (streaming) and not following', () => {
    expect(shouldShowJumpPill(false, true)).toBe(true)
    expect(shouldShowJumpPill(true, true)).toBe(false)
    expect(shouldShowJumpPill(false, false)).toBe(false)
  })
})
