// Neon (serverless Postgres) access. We use the HTTP query function, which is
// perfect for a dashboard API: every call is a discrete, stateless query.
import { readdir } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { config } from "./config.ts";

export const sql = neon(config.databaseUrl);

// ---- Types (kept in sync with migrations/001_init.sql) --------------------

export type LoopStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type RunStatus = "running" | "completed" | "failed";
export type LoopMode = "orchestrated" | "ralph";
export type RunRole = "orchestrator" | "worker";

export interface Loop {
  id: string;
  goal: string;
  status: LoopStatus;
  mode: LoopMode;
  max_iterations: number;
  iterations: number;
  model: string | null;
  workspace: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  loop_id: string | null;
  iteration: number;
  task: string;
  role: RunRole;
  parent_run_id: string | null;
  reasoning: string | null;
  status: RunStatus;
  output: string | null;
  model: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  num_turns: number | null;
  session_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface RunEvent {
  id: number;
  run_id: string | null;
  loop_id: string | null;
  event_type: string;
  detail: unknown;
  created_at: string;
}

// ---- Schema bootstrap -----------------------------------------------------

// Apply every migration in migrations/ in filename order, statement-by-statement
// (Neon HTTP runs one at a time). All migrations are idempotent (IF NOT EXISTS).
export async function initSchema(): Promise<void> {
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const text = await Bun.file(new URL(file, dir)).text();
    // Strip whole-line SQL comments first, THEN split on ';'. (Splitting first
    // would leave a file's leading comment block attached to the first
    // statement and drop it.)
    const cleaned = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = cleaned
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await sql(stmt);
    }
  }
}

// ---- Loops ----------------------------------------------------------------

export async function createLoop(input: {
  goal: string;
  mode: LoopMode;
  maxIterations: number;
  model: string;
  workspace: string;
}): Promise<Loop> {
  const rows = (await sql`
    insert into loops (goal, mode, max_iterations, model, workspace, status)
    values (${input.goal}, ${input.mode}, ${input.maxIterations}, ${input.model}, ${input.workspace}, 'pending')
    returning *
  `) as Loop[];
  return rows[0]!;
}

export async function getLoop(id: string): Promise<Loop | null> {
  const rows = (await sql`select * from loops where id = ${id}`) as Loop[];
  return rows[0] ?? null;
}

export async function listLoops(limit = 50): Promise<Loop[]> {
  return (await sql`
    select * from loops order by updated_at desc limit ${limit}
  `) as Loop[];
}

export async function updateLoop(
  id: string,
  fields: Partial<
    Pick<Loop, "status" | "iterations" | "last_error">
  >,
): Promise<void> {
  // Only a small, fixed set of columns is ever updated, so explicit branches
  // keep the queries parameterized and injection-proof.
  if (fields.status !== undefined) {
    await sql`update loops set status = ${fields.status}, updated_at = now() where id = ${id}`;
  }
  if (fields.iterations !== undefined) {
    await sql`update loops set iterations = ${fields.iterations}, updated_at = now() where id = ${id}`;
  }
  if (fields.last_error !== undefined) {
    await sql`update loops set last_error = ${fields.last_error}, updated_at = now() where id = ${id}`;
  }
}

// ---- Runs -----------------------------------------------------------------

export async function startRun(input: {
  loopId: string;
  iteration: number;
  task: string;
  model: string;
  role?: RunRole;
  parentRunId?: string | null;
}): Promise<Run> {
  const role = input.role ?? "worker";
  const parent = input.parentRunId ?? null;
  const rows = (await sql`
    insert into runs (loop_id, iteration, task, model, status, role, parent_run_id)
    values (${input.loopId}, ${input.iteration}, ${input.task}, ${input.model}, 'running', ${role}, ${parent})
    returning *
  `) as Run[];
  return rows[0]!;
}

export async function finishRun(
  id: string,
  fields: {
    status: RunStatus;
    output: string | null;
    cost_usd: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    num_turns: number | null;
    session_id: string | null;
    reasoning?: string | null;
  },
): Promise<void> {
  await sql`
    update runs set
      status = ${fields.status},
      output = ${fields.output},
      reasoning = ${fields.reasoning ?? null},
      cost_usd = ${fields.cost_usd},
      input_tokens = ${fields.input_tokens},
      output_tokens = ${fields.output_tokens},
      num_turns = ${fields.num_turns},
      session_id = ${fields.session_id},
      completed_at = now()
    where id = ${id}
  `;
}

export async function listRuns(limit = 100): Promise<Run[]> {
  return (await sql`
    select * from runs order by started_at desc limit ${limit}
  `) as Run[];
}

export async function listRunsForLoop(loopId: string): Promise<Run[]> {
  return (await sql`
    select * from runs where loop_id = ${loopId}
    order by iteration asc, started_at asc
  `) as Run[];
}

export async function getRun(id: string): Promise<Run | null> {
  const rows = (await sql`select * from runs where id = ${id}`) as Run[];
  return rows[0] ?? null;
}

// ---- Events ---------------------------------------------------------------

export async function appendEvent(input: {
  runId: string;
  loopId: string;
  type: string;
  detail: unknown;
}): Promise<void> {
  await sql`
    insert into run_events (run_id, loop_id, event_type, detail)
    values (${input.runId}, ${input.loopId}, ${input.type}, ${JSON.stringify(input.detail)})
  `;
}

export async function listEventsForRun(runId: string, limit = 500): Promise<RunEvent[]> {
  return (await sql`
    select * from run_events where run_id = ${runId} order by id asc limit ${limit}
  `) as RunEvent[];
}
