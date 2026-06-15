# Agent Control Plane

> Long-running agent loops you can actually watch. Give it a goal; agents prompt agents until it's done; every run is recorded so you can see what they did while you stepped away.

A control plane for long-running agent loops, built on **Pi** (a provider-independent coding agent) with run history in **Neon** (serverless Postgres) and a **React** dashboard. You give it a goal; it runs a loop until the goal is met, recording every run so you can see what your agents did, not just what they are doing right now. Because it drives Pi rather than any one model API, the same loop runs on Claude, GPT, Gemini, Kimi, or a local model (see [Models and providers](#models-and-providers)).

## How it works

Two loop modes:

- **orchestrated (default): agents prompting agents.** Each round an LLM **orchestrator** agent inspects progress (with read-only tools) and decides either that the goal is done or what the next task(s) are. It writes the prompts that **worker** agents then execute (with full tools). Independent tasks fan out and run in parallel. The orchestrator makes the continue/done call, not a regex.
- **ralph: the classic single-agent loop.** A fixed prompt re-runs one worker agent each round; a sentinel in its output (`LOOP_STATUS: DONE`) ends the loop.

State lives on disk (a `PROGRESS.md` per loop) and in Neon, never in a model's context, so every round starts with a fresh context. The human gate is the resume action: a loop that hits its iteration cap parks in `awaiting_approval` until you approve more rounds.

Every run (orchestrator or worker) lands in Neon with its role, output, tokens, status, and a link to the orchestrator decision that spawned it. The dashboard shows the live loop plus the full history.

```
orchestrated round:                         Neon                      React dashboard -> Retool
orchestrator agent decides  ──┐      loops / runs / run_events         live: orchestrator decision
   ├─ done -> stop            │  ->  (role: orchestrator|worker,   ->  + the workers it spawned;
   └─ tasks -> worker agents ─┘      parent_run_id, reasoning,         full run history; the human
      (fan out in parallel)          output, tokens, status)           resume gate
```

## Models and providers

The control plane never talks to a model directly. It drives **Pi**, and Pi resolves the model and provider from its own auth. So the whole loop (orchestrator and workers) runs on whatever Pi supports: Claude, GPT, Gemini, Kimi, or a local model. Switching is two steps and zero code changes.

**1. Authenticate Pi for the provider you want** (once). Either a subscription login (run `pi`, then `/login` -> Claude Pro/Max, ChatGPT Plus/Pro, or GitHub Copilot) or an API key in your environment:

| Provider | Env var |
|----------|---------|
| Anthropic / Claude | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Kimi (Moonshot) | `KIMI_API_KEY` |

Pi also supports DeepSeek, Mistral, Groq, xAI, OpenRouter, Azure OpenAI, Amazon Bedrock, Vertex AI, and local runtimes (Ollama, vLLM, LM Studio) via `~/.pi/agent/models.json`. See [Pi's provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).

**2. Set `PI_MODEL`** in `backend/.env` to a `provider/model` reference:

```bash
PI_MODEL=anthropic/claude-sonnet-4     # Claude
PI_MODEL=openai/gpt-4o                  # OpenAI
PI_MODEL=kimi-coding/kimi-for-coding    # Kimi (the default)
PI_MODEL=ollama/llama3.1:8b             # a local model
```

Run `pi` and use `/model` to see the exact model ids your auth exposes. Sanity-check any model before wiring it in:

```bash
pi --mode json --print --no-session --model anthropic/claude-sonnet-4 -p "say PI OK"
```

> **Usage signal:** metered providers (Anthropic, OpenAI, ...) report a real per-run cost; flat-rate subscriptions (like Kimi) report `$0`. The dashboard surfaces **tokens**, which are meaningful on every provider, and the raw `cost_usd` is still recorded per run.

## Project layout

| Path | What |
|------|------|
| `backend/` | Bun + TypeScript. Drives the Pi loop, persists to Neon, serves the JSON API (Hono). |
| `backend/src/pi.ts` | Spawns `pi --mode json --print` and parses its event stream. |
| `backend/src/loop.ts` | The loop driver: orchestrated (orchestrator + workers) and ralph modes, the decision parser, fan-out, and the human resume gate. |
| `backend/src/db.ts` | Neon access + the `loops` / `runs` / `run_events` schema. |
| `backend/migrations/` | `001_init.sql` (base schema) + `002_orchestrator.sql` (mode, role, parent_run_id, reasoning). |
| `backend/src/itest.ts` | Integration suite (`bun run itest`, needs the server in `ACP_FAKE_PI=1` mode). |
| `frontend/` | Vite + React + TS dashboard (mode selector, orchestrator/worker view, run history with filters and relative timestamps). The artifact you deploy with Retool. |

## Prerequisites

- [Bun](https://bun.sh) (backend runtime).
- [Pi](https://pi.dev) installed and on your PATH (`pi --version`), authed for the provider you want to run on (see [Models and providers](#models-and-providers)). Confirm with `pi --mode json --print --no-session -p "say PI OK"`.
- A [Neon](https://neon.tech) project. Copy its pooled connection string.

## Setup

```bash
cp .env.example .env
# edit .env: paste DATABASE_URL (Neon). PI_MODEL defaults to Kimi; set it to any
# Pi model ref to run on Claude, GPT, Gemini, a local model, etc. (see below).

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

Start a loop from the dashboard, or with `curl` (`mode` defaults to `orchestrated`):

```bash
curl -s localhost:8787/api/loops -X POST \
  -H 'content-type: application/json' \
  -d '{"goal":"Build a small CLI todo app in Python with pytest tests","maxIterations":5,"mode":"orchestrated"}'
```

Run the tests (start the server with `ACP_FAKE_PI=1` in another terminal first, so the suite is fast and deterministic):

```bash
bun run test     # unit tests
bun run itest    # integration suite against the running server
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

The dashboard is a standard React app, so you can host it and gate it with [Retool](https://retool.com):

1. Zip the `frontend/` source (Retool's React importer takes source, not a build; it stays well under the 50 MB cap).
2. In Retool: **Create > App > Chat tab > Import React code**, and select the zip.
3. Add a Retool **Postgres resource** pointed at the same `DATABASE_URL`, so the live panel and history read straight from Neon through a managed connector instead of credentials in code.
4. Wire the **resume** action behind a confirm dialog (the human gate on an expensive loop) and a manager-only permission, and turn on Retool's audit log for the trail.

The Bun/TS backend is not imported into Retool; Retool talks to Neon directly for reads, and to the backend's gated endpoints for actions (so the backend needs a public URL, e.g. a tunnel, for those).

## License

[MIT](LICENSE) © Cole Medin
