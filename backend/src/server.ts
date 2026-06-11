// HTTP API for the control plane. Hono on Bun. CORS is wide open so the React
// dashboard (and later Retool) can call it from anywhere during development.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.ts";
import {
  getLoop,
  getRun,
  initSchema,
  listEventsForRun,
  listLoops,
  listRuns,
  listRunsForLoop,
} from "./db.ts";
import { pauseLoop, resumeLoop, startLoop, stopLoop } from "./loop.ts";

const app = new Hono();
app.use("*", cors());

app.get("/api/health", (c) => c.json({ ok: true, model: config.piModel }));

// ---- Loops ----------------------------------------------------------------

app.get("/api/loops", async (c) => c.json(await listLoops()));

app.get("/api/loops/:id", async (c) => {
  const loop = await getLoop(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const runs = await listRunsForLoop(loop.id);
  return c.json({ ...loop, runs });
});

app.post("/api/loops", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const goal = String(body.goal ?? "").trim();
  if (!goal) return c.json({ error: "goal is required" }, 400);
  const maxIterations = clampInt(body.maxIterations, 1, 100, 10);
  const loop = await startLoop({ goal, maxIterations });
  return c.json(loop, 201);
});

// The human gate: resuming an expensive loop. Retool wires a confirm dialog to
// this button.
app.post("/api/loops/:id/resume", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const extra = clampInt(body.extraIterations, 1, 100, 5);
  const loop = await resumeLoop(c.req.param("id"), extra);
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json(loop);
});

app.post("/api/loops/:id/pause", async (c) => {
  const loop = await pauseLoop(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json(loop);
});

app.post("/api/loops/:id/stop", async (c) => {
  const loop = await stopLoop(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json(loop);
});

// ---- Runs (history) -------------------------------------------------------

app.get("/api/runs", async (c) => c.json(await listRuns()));

app.get("/api/runs/:id", async (c) => {
  const run = await getRun(c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  const events = await listEventsForRun(run.id);
  return c.json({ ...run, events });
});

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Ensure the schema exists before serving (idempotent).
await initSchema();
console.log(`Agent Control Plane API on http://localhost:${config.port}`);
console.log(`Pi model: ${config.piModel}  ·  Pi binary: ${config.piBin}`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Long-running Pi loops can exceed the default request idle timeout; raise it.
  idleTimeout: 255,
};
