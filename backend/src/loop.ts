// The loop orchestrator: the Ralph pattern made observable.
//
// Each iteration runs Pi once to make ONE increment of progress, persists that
// run (and its streamed events) to Neon, then decides whether to keep going.
// State lives on disk (a PROGRESS.md per loop) and in the database, never in the
// model's context, so every iteration starts with a fresh context window.
//
// The "human gate" the dashboard exposes is the resume action: a loop that hits
// its iteration cap parks in `awaiting_approval` and only continues when a human
// calls resumeLoop(). Resuming a long-running loop is the expensive action we
// deliberately make someone confirm.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "./config.ts";
import {
  appendEvent,
  createLoop,
  finishRun,
  getLoop,
  sql,
  startRun,
  updateLoop,
  type Loop,
} from "./db.ts";
import { runPiTask } from "./pi.ts";

// In-process control flags, keyed by loop id. The DB is the source of truth for
// status; this just lets a running loop notice a pause request between runs.
interface Control {
  pauseRequested: boolean;
  stopRequested: boolean;
  running: boolean;
}
const controls = new Map<string, Control>();

function buildIterationPrompt(loop: Loop, iteration: number): string {
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

This is iteration ${iteration} of up to ${loop.max_iterations}. Keep the increment small. Do not try to finish everything at once.`;
}

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

export async function startLoop(input: {
  goal: string;
  maxIterations: number;
}): Promise<Loop> {
  const ws = resolve(config.workspacesDir, "pending");
  const loop = await createLoop({
    goal: input.goal,
    maxIterations: input.maxIterations,
    model: config.piModel,
    workspace: ws,
  });
  // Kick off the runner without awaiting it; the API returns immediately.
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
    ctl.pauseRequested = true; // loop stops after the current run finishes
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

// max_iterations is not a normal updateLoop field (it is only changed on
// resume), so it gets its own tiny parameterized helper.
async function sqlSetMaxIterations(id: string, value: number): Promise<void> {
  await sql`update loops set max_iterations = ${value}, updated_at = now() where id = ${id}`;
}

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
        // Hit the cap. Park for a human to approve continuing (the gate).
        await updateLoop(id, { status: "awaiting_approval" });
        break;
      }

      const iteration = loop.iterations + 1;
      const ws = await ensureWorkspace({ ...loop, id });
      const prompt = buildIterationPrompt(loop, iteration);

      const run = await startRun({
        loopId: id,
        iteration,
        task: `Iteration ${iteration}: increment toward goal`,
        model: config.piModel,
      });

      const result = await runPiTask(prompt, {
        cwd: ws,
        onEvent: (e) => {
          // Persist progress events for the live dashboard. Fire-and-forget so a
          // slow write never stalls the agent stream.
          void appendEvent({
            runId: run.id,
            loopId: id,
            type: e.type,
            detail: e.detail,
          }).catch(() => {});
        },
      });

      await finishRun(run.id, {
        status: result.isError ? "failed" : "completed",
        output: result.output || result.errorDetail || null,
        cost_usd: result.costUsd,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        num_turns: result.numTurns,
        session_id: result.sessionId,
      });

      await updateLoop(id, { iterations: iteration });

      // A stop issued while this iteration was running wins over the run's
      // outcome (stopLoop already set status to 'stopped'); never let a late
      // completed/failed transition clobber the user's stop.
      if (ctl.stopRequested) break;
      if (result.isError) {
        await updateLoop(id, { status: "failed", last_error: result.errorDetail });
        break;
      }
      if (/LOOP_STATUS:\s*DONE/i.test(result.output)) {
        await updateLoop(id, { status: "completed" });
        break;
      }
      // A pause issued mid-iteration takes effect now (there is more work to do).
      if (ctl.pauseRequested) {
        await updateLoop(id, { status: "paused" });
        break;
      }
      // else CONTINUE: next iteration.
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
