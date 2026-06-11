import { describe, expect, it } from "bun:test";
import { clampInt } from "./util.ts";

describe("clampInt", () => {
  it("uses the fallback when value is missing", () => {
    expect(clampInt(undefined, 1, 100, 10)).toBe(10);
    expect(clampInt(null, 1, 100, 10)).toBe(10);
  });

  it("uses the fallback for non-numeric values", () => {
    expect(clampInt("abc", 1, 100, 10)).toBe(10);
    expect(clampInt({}, 1, 100, 10)).toBe(10);
  });

  it("clamps values above the maximum", () => {
    expect(clampInt(999, 1, 100, 10)).toBe(100);
  });

  it("clamps values below the minimum", () => {
    expect(clampInt(-3, 1, 100, 10)).toBe(1);
  });

  it("keeps in-range values unchanged", () => {
    expect(clampInt(5, 1, 100, 10)).toBe(5);
  });

  it("floors fractional values", () => {
    expect(clampInt(5.9, 1, 100, 10)).toBe(5);
  });
});
