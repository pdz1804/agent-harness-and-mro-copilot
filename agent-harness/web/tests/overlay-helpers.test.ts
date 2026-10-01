import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeLayer } from '../src/lib/anchor-position'
import { composeTitle } from '../src/lib/document-title'
import { installScrollActivity } from '../src/lib/scroll-activity'

const rect = (top: number, left: number, width = 28, height = 28) => ({ top, left, width, height, right: left + width, bottom: top + height })
const viewport = { width: 1440, height: 900 }

describe('placeLayer', () => {
  it('opens below, aligned to the trigger end', () => {
    const p = placeLayer(rect(100, 500), { width: 200, height: 150 }, viewport, 'end')
    expect(p).toEqual({ top: 134, left: 328, above: false })
  })
  it('flips above when there is no room below', () => {
    const p = placeLayer(rect(800, 500), { width: 200, height: 150 }, viewport, 'start')
    expect(p.above).toBe(true)
    expect(p.top).toBe(800 - 6 - 150)
    expect(p.left).toBe(500)
  })
  it('stays inside the viewport margin', () => {
    const p = placeLayer(rect(100, 2), { width: 300, height: 100 }, viewport, 'end')
    expect(p.left).toBe(8)
    const q = placeLayer(rect(100, 1430), { width: 300, height: 100 }, viewport, 'start')
    expect(q.left).toBe(1440 - 300 - 8)
  })
})

describe('composeTitle', () => {
  it('composes item, section, app and the waiting-approvals count', () => {
    expect(composeTitle('Incidents', 'INC-7', 0)).toBe('INC-7 · Incidents · Agent Harness')
    expect(composeTitle('Incidents', '', 0)).toBe('Incidents · Agent Harness')
    expect(composeTitle('Incidents', 'Incidents', 0)).toBe('Incidents · Agent Harness')
    expect(composeTitle('', '', 2)).toMatch(/^\(2\) Agent Harness$/)
  })
})

describe('installScrollActivity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flags the scrolling element and clears the flag after idle', () => {
    const attrs = new Set<string>()
    const target = {
      setAttribute: (n: string) => attrs.add(n),
      removeAttribute: (n: string) => attrs.delete(n),
      hasAttribute: (n: string) => attrs.has(n),
    }
    let handler: ((e: Event) => void) | null = null
    const doc = {
      scrollingElement: null,
      addEventListener: (_t: string, h: (e: Event) => void) => {
        handler = h
      },
      removeEventListener: vi.fn(),
    } as unknown as Document
    const uninstall = installScrollActivity(doc, 500)
    handler!({ target } as unknown as Event)
    expect(attrs.has('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(400)
    handler!({ target } as unknown as Event) // still scrolling: idle timer restarts
    vi.advanceTimersByTime(400)
    expect(attrs.has('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(attrs.has('data-scrolling')).toBe(false)
    uninstall()
    expect(doc.removeEventListener).toHaveBeenCalled()
  })
})
