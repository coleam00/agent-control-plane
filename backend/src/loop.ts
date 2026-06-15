// The loop orchestrator. Two modes:
//
//  - "orchestrated" (default): genuine agents-prompting-agents. Each round an
//    LLM ORCHESTRATOR agent inspects progress (read-only tools) and decides
//    either that the goal is done, or what the next task(s) are. It then writes
//    the prompt(s) that WORKER agents execute (with full tools). Independent
//    tasks fan out and run in parallel. The orchestrator is a real agent making
//    the continue/done call, not a regex.
//
//  - "ralph": the classic single-agent loop. A fixed prompt re-runs one worker
//    agent each iteration; a regex on its output decides continue/done. Kept so
//    the simple pattern is still available (and to contrast on camera).
//
// State lives on disk (PROGRESS.md per loop) and in Neon, never in a model's
// context, so every run starts fresh. The human gate is the resume action: a
// loop that hits its iteration cap parks in `awaiting_approval`.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "./config.ts";
import {
  appendEvent,
  createLoop,
  finishRun,
  getLoop,
  listRunsForLoop,
  sql,
  startRun,
  updateLoop,
  type Loop,
  type LoopMode,
  type Run,
} from "./db.ts";
import { runPiTask, type PiResult } from "./pi.ts";

const ORCHESTRATOR_TOOLS = ["read", "ls", "find", "grep"]; // read-only: it decides, it does not build
const MAX_FANOUT = 4; // most parallel worker agents the orchestrator may spawn per round

// In-process control flags, keyed by loop id. The DB is the source of truth for
// status; this just lets a running loop notice a pause/stop request between runs.
interface Control {
  pauseRequested: boolean;
  stopRequested: boolean;
  running: boolean;
}
const controls = new Map<string, Control>();

interface Decision {
  status: "continue" | "done";
  reasoning: string;
  tasks: string[];
}

type IterationOutcome =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "failed"; error: string };

// ---- Prompts --------------------------------------------------------------

function buildRalphPrompt(loop: Loop, iteration: number): string {
  return `You are an autonomous build agent running in a loop. Each iteration you make ONE small, verifiable increment of progress toward the goal, then stop.

GOAL:
${loop.goal}

Your working directory is this folder. State persists between iterations on disk, NOT in your memory, so every iteration you must:
1. Read PROGRESS.md to see what is already done and what comes next.
2. Do the single next increment of real work (create/edit files, run commands to verify).
3. Update PROGRESS.md: check off what you finished and write the next concrete step.
4. End your final message with exactly one of these lines, on its own line:
   LOOP_STATUS: CONTINUE   (more work remains)
   LOOP_STATUS: DONE       (the goal is fully met and verified)

This is iteration ${iteration} of up to ${loop.max_iterations}. Keep the increment small.`;
}

function buildOrchestratorPrompt(loop: Loop, iteration: number, recent: string): string {
  return `You are the orchestrator agent driving a team of worker agents toward a goal. You do NOT write code or run build commands yourself. Each round you look at what has been done and decide what the workers should do next, or whether the goal is fully met.

GOAL:
${loop.goal}

You may inspect the working directory with your read-only tools (read, ls, find, grep) to see what has actually been built. PROGRESS.md tracks state.

What the worker agents did most recently:
${recent}

Decide ONE of:
- The goal is fully met and verified  ->  status "done".
- There is more to do  ->  status "continue", with 1 to ${MAX_FANOUT} concrete next tasks.

How to break the work down:
- A substantial goal is built over SEVERAL rounds, layer by layer; that is expected and good. Each round, advance the next layer of work, then let the following round build on what now exists. Do NOT try to finish everything in one round.
- Maximize parallelism within a round: when the work in front of you has multiple INDEPENDENT pieces that do not touch the same files (for example separate modules, or one test file per module), give EACH piece its own task so the workers run in parallel. Do NOT bundle independent pieces into a single task.
- Build in dependency order across rounds: do not dispatch a task whose prerequisites do not exist yet; wait for the round after they are built (e.g. build the modules first, then the CLI that imports them, then the tests, then the docs).
- Keep each task small and self-contained. Do not redo finished work.
- Only call "done" once the code exists, runs, and is tested and documented as the goal requires.

This is round ${iteration} of at most ${loop.max_iterations}.

End your reply with a single JSON object on its own line, inside a fenced code block, exactly in this shape:
\`\`\`json
{"status": "continue", "reasoning": "<one short sentence>", "tasks": ["<task>", "<task>"]}
\`\`\`
For "done", use an empty tasks array.`;
}

function buildWorkerPrompt(loop: Loop, task: string): string {
  return `You are a worker agent on a team building toward a larger goal. Do exactly the task you are given, fully and verified, then stop. Other agents may be handling other tasks in parallel, so stay strictly within yours.

OVERALL GOAL (for context only):
${loop.goal}

YOUR TASK THIS ROUND:
${task}

Work in the current directory using your tools (read, bash, edit, write). Verify your work by running or testing it. When finished, briefly note what you did in PROGRESS.md. Keep your final message short: what you did and whether it worked.`;
}

// ---- Decision parsing -----------------------------------------------------

function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function coerceDecision(raw: string): Decision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== "continue" && status !== "done") return null;
  const tasks = Array.isArray(obj.tasks)
    ? obj.tasks.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
  return { status, reasoning, tasks };
}

// Pull the orchestrator's decision out of its free-text reply. Prefers a fenced
// ```json block, falls back to any balanced {...}, tries newest first.
export function parseDecision(text: string): Decision | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) candidates.push(m[1]!);
  candidates.push(...extractJsonObjects(text));
  for (let i = candidates.length - 1; i >= 0; i--) {
    const d = coerceDecision(candidates[i]!);
    if (d) return d;
  }
  return null;
}

// ---- Workspace ------------------------------------------------------------

async function ensureWorkspace(loop: Loop): Promise<string> {
  const ws = resolve(config.workspacesDir, loop.id);
  await mkdir(ws, { recursive: true });
  const progress = join(ws, "PROGRESS.md");
  if (!(await Bun.file(progress).exists())) {
    await Bun.write(
      progress,
      `# Progress\n\nGoal: ${loop.goal}\n\n## Done\n\n## Next\n- [ ] Get started on the goal.\n`,
    );
  }
  return ws;
}

function recentWorkerSummary(runs: Run[]): string {
  const workers = runs.filter((r) => r.role === "worker").slice(-6);
  if (workers.length === 0) return "Nothing yet. This is the first round.";
  return workers
    .map((r) => {
      const out = (r.output ?? "").replace(/\s+/g, " ").slice(0, 240);
      return `- [round ${r.iteration}] (${r.status}) ${r.task}: ${out}`;
    })
    .join("\n");
}

// ---- Lifecycle ------------------------------------------------------------

export async function startLoop(input: {
  goal: string;
  mode: LoopMode;
  maxIterations: number;
}): Promise<Loop> {
  const ws = resolve(config.workspacesDir, "pending");
  const loop = await createLoop({
    goal: input.goal,
    mode: input.mode,
    maxIterations: input.maxIterations,
    model: config.piModel,
    workspace: ws,
  });
  void runLoop(loop.id);
  return loop;
}

export async function resumeLoop(
  id: string,
  extraIterations: number,
): Promise<Loop | null> {
  const loop = await getLoop(id);
  if (!loop) return null;
  if (controls.get(id)?.running) return loop; // already going
  const newCap = loop.max_iterations + Math.max(1, extraIterations);
  await updateLoop(id, { status: "running" });
  await sqlSetMaxIterations(id, newCap);
  void runLoop(id);
  return await getLoop(id);
}

export async function pauseLoop(id: string): Promise<Loop | null> {
  const ctl = controls.get(id);
  if (ctl?.running) {
    ctl.pauseRequested = true; // loop stops after the current round finishes
  } else {
    await updateLoop(id, { status: "paused" });
  }
  return await getLoop(id);
}

export async function stopLoop(id: string): Promise<Loop | null> {
  const ctl = controls.get(id);
  if (ctl) ctl.stopRequested = true;
  await updateLoop(id, { status: "stopped" });
  return await getLoop(id);
}

// max_iterations is only changed on resume, so it gets its own tiny helper.
async function sqlSetMaxIterations(id: string, value: number): Promise<void> {
  await sql`update loops set max_iterations = ${value}, updated_at = now() where id = ${id}`;
}

// ---- The loop ------------------------------------------------------------

async function runLoop(id: string): Promise<void> {
  const ctl: Control = { pauseRequested: false, stopRequested: false, running: true };
  controls.set(id, ctl);
  try {
    await updateLoop(id, { status: "running" });

    while (true) {
      const loop = await getLoop(id);
      if (!loop) break;
      if (loop.status === "stopped" || ctl.stopRequested) break;

      if (ctl.pauseRequested) {
        await updateLoop(id, { status: "paused" });
        break;
      }
      if (loop.iterations >= loop.max_iterations) {
        await updateLoop(id, { status: "awaiting_approval" }); // the human gate
        break;
      }

      const iteration = loop.iterations + 1;
      const ws = await ensureWorkspace(loop);

      let outcome: IterationOutcome;
      try {
        outcome =
          loop.mode === "ralph"
            ? await ralphIteration(loop, iteration, ws)
            : await orchestratedIteration(loop, iteration, ws, ctl);
      } catch (err) {
        outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      }

      await updateLoop(id, { iterations: iteration });

      // A stop issued mid-round wins over this round's outcome (the fix that
      // keeps a user stop from being clobbered into completed/failed).
      if (ctl.stopRequested) break;
      if (outcome.kind === "failed") {
        await updateLoop(id, { status: "failed", last_error: outcome.error });
        break;
      }
      if (outcome.kind === "done") {
        await updateLoop(id, { status: "completed" });
        break;
      }
      if (ctl.pauseRequested) {
        await updateLoop(id, { status: "paused" });
        break;
      }
      // continue -> next round
    }
  } catch (err) {
    await updateLoop(id, {
      status: "failed",
      last_error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  } finally {
    ctl.running = false;
    controls.delete(id);
  }
}

// ---- Ralph mode (single agent, regex decides) -----------------------------

async function ralphIteration(loop: Loop, iteration: number, ws: string): Promise<IterationOutcome> {
  const run = await startRun({
    loopId: loop.id,
    iteration,
    task: `Iteration ${iteration}: increment toward goal`,
    model: config.piModel,
    role: "worker",
  });
  const result = await runPiTask(buildRalphPrompt(loop, iteration), {
    cwd: ws,
    onEvent: (e) => void persistEvent(run.id, loop.id, e).catch(() => {}),
  });
  await finishRun(run.id, runFields(result));

  if (result.isError) return { kind: "failed", error: result.errorDetail || "agent run failed" };
  if (/LOOP_STATUS:\s*DONE/i.test(result.output)) return { kind: "done" };
  return { kind: "continue" };
}

// ---- Orchestrated mode (agents prompting agents) --------------------------

async function orchestratedIteration(
  loop: Loop,
  iteration: number,
  ws: string,
  ctl: Control,
): Promise<IterationOutcome> {
  // 1. The orchestrator agent inspects state and decides.
  const recent = recentWorkerSummary(await listRunsForLoop(loop.id));
  const orchRun = await startRun({
    loopId: loop.id,
    iteration,
    task: `Round ${iteration}: orchestrator decides next step`,
    model: config.piModel,
    role: "orchestrator",
  });
  const orchResult = await runPiTask(buildOrchestratorPrompt(loop, iteration, recent), {
    cwd: ws,
    tools: ORCHESTRATOR_TOOLS,
    onEvent: (e) => void persistEvent(orchRun.id, loop.id, e).catch(() => {}),
  });
  const decision = parseDecision(orchResult.output);
  await finishRun(orchRun.id, {
    ...runFields(orchResult),
    status: orchResult.isError || !decision ? "failed" : "completed",
    reasoning: decision?.reasoning ?? null,
  });

  if (orchResult.isError) {
    return { kind: "failed", error: `orchestrator agent failed: ${orchResult.errorDetail}` };
  }
  if (!decision) {
    return { kind: "failed", error: "could not parse the orchestrator's decision (no valid JSON)" };
  }
  if (decision.status === "done") return { kind: "done" };

  const tasks = decision.tasks.slice(0, MAX_FANOUT);
  if (tasks.length === 0) {
    return { kind: "failed", error: "orchestrator said continue but gave no tasks" };
  }
  if (ctl.stopRequested) return { kind: "continue" };

  // 2. Worker agents execute the decided tasks (fan out in parallel). A worker
  //    failure is recorded but NOT fatal: the orchestrator sees it next round
  //    and can adjust. The iteration cap bounds any retrying.
  await Promise.all(tasks.map((task) => runWorker(loop, iteration, ws, orchRun.id, task)));

  return { kind: "continue" };
}

async function runWorker(
  loop: Loop,
  iteration: number,
  ws: string,
  parentRunId: string,
  task: string,
): Promise<void> {
  const run = await startRun({
    loopId: loop.id,
    iteration,
    task,
    model: config.piModel,
    role: "worker",
    parentRunId,
  });
  const result = await runPiTask(buildWorkerPrompt(loop, task), {
    cwd: ws,
    onEvent: (e) => void persistEvent(run.id, loop.id, e).catch(() => {}),
  });
  await finishRun(run.id, runFields(result));
}

// ---- Shared helpers -------------------------------------------------------

function runFields(result: PiResult) {
  return {
    status: result.isError ? ("failed" as const) : ("completed" as const),
    output: result.output || result.errorDetail || null,
    cost_usd: result.costUsd,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    num_turns: result.numTurns,
    session_id: result.sessionId,
  };
}

async function persistEvent(
  runId: string,
  loopId: string,
  e: { type: string; detail: Record<string, unknown> },
): Promise<void> {
  await appendEvent({ runId, loopId, type: e.type, detail: e.detail });
}
