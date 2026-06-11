export function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  // Treat missing values as absent, not as 0. (Number(null) is 0, which would
  // otherwise clamp to the min instead of using the fallback.)
  if (v === null || v === undefined) return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
