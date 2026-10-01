import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoQueue } from "./undo-queue";

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("undo-queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("deferred: does not send until the window ends", async () => {
    const q = createUndoQueue(5000);
    const commit = vi.fn(() => Promise.resolve());
    const onSettled = vi.fn();
    q.push({ id: "a", strategy: "deferred", commit, onSettled });
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    await flushPromises();
    expect(commit).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(q.pending()).toEqual([]);
  });

  it("deferred: undo cancels without any request", async () => {
    const q = createUndoQueue(5000);
    const commit = vi.fn(() => Promise.resolve());
    const onUndone = vi.fn();
    q.push({ id: "a", strategy: "deferred", commit, onUndone });
    expect(await q.undo("a")).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(commit).not.toHaveBeenCalled();
    expect(onUndone).toHaveBeenCalledOnce();
  });

  it("compensate: sends now, undo sends the reverse", async () => {
    const q = createUndoQueue(5000);
    const commit = vi.fn(() => Promise.resolve());
    const revert = vi.fn(() => Promise.resolve());
    q.push({ id: "b", strategy: "compensate", commit, revert });
    expect(commit).toHaveBeenCalledOnce();
    expect(await q.undo("b")).toBe(true);
    expect(revert).toHaveBeenCalledOnce();
  });

  it("compensate requires a revert", () => {
    const q = createUndoQueue();
    expect(() => q.push({ id: "c", strategy: "compensate", commit: () => Promise.resolve() })).toThrow();
  });

  it("reports commit failures so the UI can roll back", async () => {
    const q = createUndoQueue(1000);
    const onError = vi.fn();
    q.push({ id: "d", strategy: "deferred", commit: () => Promise.reject(new Error("409")), onError });
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(onError).toHaveBeenCalledOnce();
    expect(q.pending()).toEqual([]);
  });

  it("undo after the window is a no-op", async () => {
    const q = createUndoQueue(1000);
    q.push({ id: "e", strategy: "deferred", commit: () => Promise.resolve() });
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(await q.undo("e")).toBe(false);
  });

  it("flush commits deferred jobs immediately", async () => {
    const q = createUndoQueue(5000);
    const commit = vi.fn(() => Promise.resolve());
    q.push({ id: "f", strategy: "deferred", commit });
    q.flush();
    expect(commit).toHaveBeenCalledOnce();
    await flushPromises();
    expect(q.pending()).toEqual([]);
  });

  it("ignores a duplicate push", () => {
    const q = createUndoQueue(5000);
    const commit = vi.fn(() => Promise.resolve());
    q.push({ id: "g", strategy: "deferred", commit });
    q.push({ id: "g", strategy: "deferred", commit });
    expect(q.pending()).toEqual(["g"]);
  });
});
