import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferAction, flushDeferred, hasPendingAction } from '../src/lib/deferred-action'

describe('deferAction', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    flushDeferred()
    vi.useRealTimers()
  })

  it('sends the action after the delay', async () => {
    const run = vi.fn(async () => 'ok')
    deferAction('k1', run, 1000)
    expect(hasPendingAction('k1')).toBe(true)
    vi.advanceTimersByTime(999)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledOnce()
    expect(hasPendingAction('k1')).toBe(false)
  })

  it('cancel (Undo) stops it in time and reports success', () => {
    const run = vi.fn(async () => 'ok')
    const cancel = deferAction('k2', run, 1000)
    expect(cancel()).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
    expect(cancel()).toBe(false)
  })

  it('cancel after it was sent reports false', () => {
    const cancel = deferAction('k3', async () => 'ok', 10)
    vi.advanceTimersByTime(10)
    expect(cancel()).toBe(false)
  })

  it('a newer action for the same key sends the older one first', () => {
    const first = vi.fn(async () => 1)
    const second = vi.fn(async () => 2)
    const cancelFirst = deferAction('k4', first, 1000)
    deferAction('k4', second, 1000)
    expect(first).toHaveBeenCalledOnce()
    expect(cancelFirst()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(second).toHaveBeenCalledOnce()
  })

  it('flushDeferred sends everything still waiting (tab closing)', () => {
    const a = vi.fn(async () => 1)
    const b = vi.fn(async () => 2)
    deferAction('fa', a, 60_000)
    deferAction('fb', b, 60_000)
    flushDeferred()
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(hasPendingAction('fa') || hasPendingAction('fb')).toBe(false)
  })

  it('routes a failed send to onError instead of throwing', async () => {
    const onError = vi.fn()
    deferAction('k5', async () => Promise.reject(new Error('409')), 5, onError)
    vi.advanceTimersByTime(5)
    await vi.runAllTimersAsync()
    expect(onError).toHaveBeenCalledOnce()
    expect((onError.mock.calls[0][0] as Error).message).toBe('409')
  })
})
