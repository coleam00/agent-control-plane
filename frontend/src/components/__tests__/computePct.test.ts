import { describe, it, expect } from "vitest";
import { computePct } from "../LiveLoopPanel";

describe("computePct", () => {
  it("returns 0 when maxIterations is 0", () => {
    expect(computePct(5, 0)).toBe(0);
    expect(computePct(0, 0)).toBe(0);
  });

  it("computes percentage normally", () => {
    expect(computePct(0, 10)).toBe(0);
    expect(computePct(5, 10)).toBe(50);
    expect(computePct(10, 10)).toBe(100);
  });

  it("clamps to 100 when iterations exceed max", () => {
    expect(computePct(15, 10)).toBe(100);
    expect(computePct(999, 10)).toBe(100);
  });
});
