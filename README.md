# Agent Control Plane

A control plane for long-running agent loops, built on **Pi** (a provider-
independent coding agent, here on Kimi) with run history in **Neon** (serverless
Postgres) and a **React** dashboard. You give it a goal; it runs a loop until the
goal is met, recording every run so you can see what your agents did while you
stepped away, not just what they are doing right now.

Two modes:

- **orchestrated (default): agents prompting agents.** Each round an LLM
  **orchestrator** agent inspects progress (with read-only tools) and decides
  either that the goal is done or what the next task(s) are. It writes the
  prompts that **worker** agents then execute (with full tools). Independent
  tasks fan out and run in parallel. The orchestrator makes the continue/done
  call, not a regex.
- **ralph: the classic single-agent loop.** A fixed prompt re-runs one worker
  agent each round; a sentinel in its output (`LOOP_STATUS: DONE`) ends the loop.
  State lives on disk and in Neon, so every round starts with a fresh context.

Every run (orchestrator or worker) lands in Neon with its role, output, tokens,
status, and a link to the orchestrator decision that spawned it. The dashboard
shows the live loop plus the full history, and gets deployed with **Retool** for
hosting, a managed Neon connection, a human approval gate, and an audit trail.

```
orchestrated round:                         Neon                      React dashboard -> Retool
orchestrator agent decides  ──┐      loops / runs / run_events         live: orchestrator decision
   ├─ done -> stop            │  ->  (role: orchestrator|worker,   ->  + the workers it spawned;
   └─ tasks -> worker agents ─┘      parent_run_id, reasoning,         full run history; the human
      (fan out in parallel)          output, tokens, status)           resume gate
```

## Layout

| Path | What |
|------|------|
| `backend/` | Bun + TypeScript. Drives the Pi loop, persists to Neon, serves the JSON API (Hono). |
| `backend/src/pi.ts` | Spawns `pi --mode json --print` and parses its event stream. |
| `backend/src/loop.ts` | The loop driver: orchestrated (orchestrator + workers) and ralph modes, the decision parser, fan-out, and the human resume gate. |
| `backend/src/db.ts` | Neon access + the `loops` / `runs` / `run_events` schema. |
| `backend/migrations/` | `001_init.sql` (base schema, mirrors Archon's run model) + `002_orchestrator.sql` (mode, role, parent_run_id, reasoning). |
| `backend/src/itest.ts` | 65-check integration suite (`bun run itest`, needs the server in `ACP_FAKE_PI=1` mode). |
| `frontend/` | Vite + React + TS dashboard (mode selector, orchestrator/worker view). The artifact imported into Retool. |

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

Start a loop from the dashboard (or `curl`). `mode` defaults to `orchestrated`:

```bash
curl -s localhost:8787/api/loops -X POST \
  -H 'content-type: application/json' \
  -d '{"goal":"Build a small CLI todo app in Python with pytest tests","maxIterations":5,"mode":"orchestrated"}'
```

Run the tests (start the server with `ACP_FAKE_PI=1` in another terminal first,
so the suite is fast and deterministic):

```bash
bun run test     # unit tests (clampInt, etc.)
bun run itest    # 65-check integration suite against the running server
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | liveness + active model |
| GET | `/api/loops` | all loops |
| GET | `/api/loops/:id` | one loop + its runs |
| POST | `/api/loops` | start a loop `{goal, maxIterations, mode?}` (mode: `orchestrated` default, or `ralph`) |
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
