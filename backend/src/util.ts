export function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
