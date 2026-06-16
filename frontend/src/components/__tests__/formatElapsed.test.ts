import { describe, it, expect } from "vitest";
import { formatElapsed } from "../LiveLoopPanel";

describe("formatElapsed", () => {
  it("formats seconds only", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1)).toBe("1s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(90)).toBe("1m 30s");
    expect(formatElapsed(3599)).toBe("59m 59s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatElapsed(3600)).toBe("1h 0m 0s");
    expect(formatElapsed(3661)).toBe("1h 1m 1s");
    expect(formatElapsed(7322)).toBe("2h 2m 2s");
  });

  it("clamps negative input to 0s", () => {
    expect(formatElapsed(-1)).toBe("0s");
    expect(formatElapsed(-999)).toBe("0s");
  });
});
