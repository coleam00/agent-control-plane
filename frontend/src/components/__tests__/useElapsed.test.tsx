import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useElapsed } from "../LiveLoopPanel";

describe("useElapsed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '' when inactive", () => {
    const { result } = renderHook(() => useElapsed("2026-01-01T00:00:00Z", false));
    expect(result.current).toBe("");
  });

  it("returns '' and clears interval when active becomes false", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useElapsed("2026-01-01T00:00:00Z", active),
      { initialProps: { active: true } },
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).not.toBe("");

    rerender({ active: false });
    expect(result.current).toBe("");
  });

  it("increments elapsed each second", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { result } = renderHook(() => useElapsed("2026-01-01T00:00:00Z", true));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toMatch(/\d+s/);
  });

  it("returns '' for invalid createdAt", () => {
    const { result } = renderHook(() => useElapsed("not-a-date", true));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe("");
  });
});
