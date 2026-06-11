# Agent Control Plane

A control plane for long-running agent loops. You give it a goal, it runs **Pi**
(a provider-independent coding agent, here on Kimi) in a loop, making one small
verifiable increment per iteration. Every run, its output, cost, and token usage
land in **Neon** (serverless Postgres) so you can see what your agents did while
you stepped away, not just what they are doing right now. A **React** dashboard
shows the live loop plus the full run history, and gets deployed with **Retool**
for hosting, a managed Neon connection, a human approval gate, and an audit trail.

This is the "Ralph" pattern (a loop that feeds an agent and lets state live on
disk and in a database, not in the model's context) made observable, and a face
on the autonomous build loops the second brain already runs headless.

```
Pi loop (Bun + TS backend)        Neon (serverless Postgres)        React dashboard -> Retool
-------------------------         --------------------------        -----------------------
runs `pi --mode json` per     ->  loops / runs / run_events    ->   live panel + run history
iteration, captures output,       (status, output, cost,             read from Neon via the API;
cost, tokens, writes to Neon      tokens, timestamps)                Retool adds host + gate + RBAC
```

## Layout

| Path | What |
|------|------|
| `backend/` | Bun + TypeScript. Drives the Pi loop, persists to Neon, serves the JSON API (Hono). |
| `backend/src/pi.ts` | Spawns `pi --mode json --print` and parses its event stream. |
| `backend/src/loop.ts` | The loop orchestrator (Ralph pattern + the human resume gate). |
| `backend/src/db.ts` | Neon access + the `loops` / `runs` / `run_events` schema. |
| `backend/migrations/001_init.sql` | Schema. Mirrors Archon's run model. |
| `frontend/` | Vite + React + TS dashboard. The artifact imported into Retool. |

## Prerequisites

- [Bun](https://bun.sh) (backend runtime).
- [Pi](https://pi.dev) installed and on your PATH (`pi --version`), authed for Kimi
  (`KIMI_API_KEY` or `~/.pi/agent/auth.json`). Confirm with `pi --mode json --print --no-session -p "say PI OK"`.
- A [Neon](https://neon.tech) project. Copy its pooled connection string.

## Setup

```bash
cp .env.example .env
# edit .env: paste DATABASE_URL (Neon), confirm PI_MODEL=kimi-coding/kimi-for-coding

cd backend
bun install
bun run migrate     # create the tables in Neon
bun run smoke       # end-to-end: Neon connection + one real Pi run
bun run dev         # API on http://localhost:8787
```

```bash
cd frontend
bun install         # or npm install
bun run dev         # dashboard on http://localhost:5173
```

Start a loop from the dashboard (or `curl`):

```bash
curl -s localhost:8787/api/loops -X POST \
  -H 'content-type: application/json' \
  -d '{"goal":"Build a small CLI todo app in Python with pytest tests","maxIterations":5}'
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | liveness + active model |
| GET | `/api/loops` | all loops |
| GET | `/api/loops/:id` | one loop + its runs |
| POST | `/api/loops` | start a loop `{goal, maxIterations}` |
| POST | `/api/loops/:id/resume` | the human gate: continue past the cap `{extraIterations}` |
| POST | `/api/loops/:id/pause` | pause after the current run |
| POST | `/api/loops/:id/stop` | stop the loop |
| GET | `/api/runs` | full run history |
| GET | `/api/runs/:id` | one run + its streamed events |

## Deploying with Retool

The dashboard is a standard React app, which is what Retool imports.

1. Build it: `cd frontend && bun run build` (zip stays well under Retool's 50 MB import cap).
2. In Retool, create a new app and import the React build (UI-based import).
3. Add a Retool **Neon / Postgres resource** pointed at the same `DATABASE_URL`, so the
   live panel and history read straight from Neon through a managed connector instead
   of credentials in code.
4. Wire the **resume** action behind a confirm dialog (the human gate on an expensive loop)
   and a manager-only permission, and turn on Retool's audit log for the trail.

The Bun/TS backend is not imported into Retool; Retool talks to Neon directly for reads,
and to the backend's gated endpoints for actions.
