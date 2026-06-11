import type { Loop, LoopDetail, Run } from "./types.ts";

// In Retool this gets swapped for a Retool resource; in dev it points at the
// local Bun backend.
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  listLoops: () => http<Loop[]>("/api/loops"),
  getLoop: (id: string) => http<LoopDetail>(`/api/loops/${id}`),
  listRuns: () => http<Run[]>("/api/runs"),
  startLoop: (goal: string, maxIterations: number) =>
    http<Loop>("/api/loops", {
      method: "POST",
      body: JSON.stringify({ goal, maxIterations }),
    }),
  resumeLoop: (id: string, extraIterations: number) =>
    http<Loop>(`/api/loops/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({ extraIterations }),
    }),
  pauseLoop: (id: string) =>
    http<Loop>(`/api/loops/${id}/pause`, { method: "POST" }),
  stopLoop: (id: string) =>
    http<Loop>(`/api/loops/${id}/stop`, { method: "POST" }),
};
