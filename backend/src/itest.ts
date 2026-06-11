// Comprehensive integration tests against the LIVE server + Neon.
//
// Requires the server running with ACP_FAKE_PI=1 (fast, deterministic Pi):
//   ACP_FAKE_PI=1 bun run start      # in one terminal
//   bun run itest                    # in another
//
// Covers: API validation + clamping, multi-iteration loops with on-disk state,
// the cap -> awaiting_approval -> resume gate, pause/resume, stop, failure
// handling, concurrency with no cross-contamination, run history + events, and
// resume-while-running being a no-op. Creates its own loops and deletes them at
// the end (cascades), leaving any pre-existing data untouched.
import { resolve } from "node:path";
import { sql } from "./db.ts";

const BASE = process.env.ACP_BASE ?? "http://localhost:8787";
const created = new Set<string>();
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ->  " + detail : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Resp {
  status: number;
  body: any;
}
async function call(method: string, path: string, body?: unknown): Promise<Resp> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function start(
  goal: string,
  maxIterations?: number,
  mode: "orchestrated" | "ralph" = "ralph",
): Promise<any> {
  const { body } = await call("POST", "/api/loops", { goal, maxIterations, mode });
  if (body?.id) created.add(body.id);
  return body;
}
const getLoop = async (id: string) => (await call("GET", `/api/loops/${id}`)).body;
const getRun = async (id: string) => (await call("GET", `/api/runs/${id}`)).body;

async function poll(
  id: string,
  pred: (loop: any) => boolean,
  timeoutMs = 30000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let loop = await getLoop(id);
  while (Date.now() < deadline) {
    if (pred(loop)) return loop;
    await sleep(250);
    loop = await getLoop(id);
  }
  return loop;
}

const terminal = (s: string) =>
  ["completed", "failed", "stopped", "awaiting_approval", "paused"].includes(s);

async function main() {
  console.log(`Integration tests against ${BASE}\n`);

  // --- A. API validation + clamping ---------------------------------------
  check("validation: empty body -> 400", (await call("POST", "/api/loops", {})).status === 400);
  check(
    "validation: blank goal -> 400",
    (await call("POST", "/api/loops", { goal: "   " })).status === 400,
  );
  check(
    "validation: unknown loop -> 404",
    (await call("GET", "/api/loops/11111111-1111-1111-1111-111111111111")).status === 404,
  );
  check(
    "validation: unknown run -> 404",
    (await call("GET", "/api/runs/11111111-1111-1111-1111-111111111111")).status === 404,
  );

  const hi = await start("clamp high", 999);
  check("clamp: maxIterations 999 -> 100", hi.max_iterations === 100, `got ${hi?.max_iterations}`);
  const lo = await start("clamp low", -3);
  check("clamp: maxIterations -3 -> 1", lo.max_iterations === 1, `got ${lo?.max_iterations}`);
  const def = await start("clamp default");
  check("clamp: missing maxIterations -> 10", def.max_iterations === 10, `got ${def?.max_iterations}`);

  // --- B. Multi-iteration loop + on-disk state ----------------------------
  const b = await start("[steps=3] build incrementally", 5);
  const bDone = await poll(b.id, (l) => terminal(l.status));
  check("multi-iter: completes", bDone.status === "completed", bDone.status);
  check("multi-iter: ran exactly 3 iterations", bDone.iterations === 3, `iterations=${bDone.iterations}`);
  check("multi-iter: 3 run rows", bDone.runs?.length === 3, `runs=${bDone.runs?.length}`);
  check(
    "multi-iter: iterations are 1,2,3 all completed",
    JSON.stringify(bDone.runs?.map((r: any) => r.iteration)) === "[1,2,3]" &&
      bDone.runs.every((r: any) => r.status === "completed"),
  );
  check(
    "multi-iter: every run has tokens + session id",
    bDone.runs?.every((r: any) => r.input_tokens > 0 && r.session_id),
  );
  const firstRun = await getRun(bDone.runs[0].id);
  const evTypes = new Set((firstRun.events ?? []).map((e: any) => e.event_type));
  check(
    "multi-iter: run events persisted (tool_start/tool_end/text/turn_end)",
    ["tool_start", "tool_end", "text", "turn_end"].every((t) => evTypes.has(t)),
    [...evTypes].join(","),
  );
  const counterFile = resolve(process.env.WORKSPACES_DIR ?? "workspaces", b.id, "_fake_count.txt");
  const counter = (await Bun.file(counterFile).text().catch(() => "")).trim();
  check("multi-iter: on-disk state carried across iterations (count=3)", counter === "3", `count=${counter}`);

  // --- C. cap -> awaiting_approval -> resume -> completes ------------------
  const c = await start("[steps=5] needs more than the cap", 2);
  const cCap = await poll(c.id, (l) => terminal(l.status));
  check("gate: hits cap as awaiting_approval", cCap.status === "awaiting_approval", cCap.status);
  check("gate: parked at iteration 2", cCap.iterations === 2, `iterations=${cCap.iterations}`);
  await call("POST", `/api/loops/${c.id}/resume`, { extraIterations: 3 });
  const cDone = await poll(c.id, (l) => l.status === "completed" || l.status === "failed");
  check("gate: completes after resume", cDone.status === "completed", cDone.status);
  check("gate: cap raised to 5 and ran all 5", cDone.iterations === 5 && cDone.max_iterations === 5,
    `iterations=${cDone.iterations} max=${cDone.max_iterations}`);
  check("gate: 5 run rows total", cDone.runs?.length === 5, `runs=${cDone.runs?.length}`);

  // --- D. pause mid-flight -> resume --------------------------------------
  const d = await start("[steps=8] long enough to pause", 8);
  await poll(d.id, (l) => l.iterations >= 2 || terminal(l.status), 15000); // let a couple iterations land
  await call("POST", `/api/loops/${d.id}/pause`);
  const dPaused = await poll(d.id, (l) => l.status === "paused" || l.status === "completed");
  check("pause: reaches paused state", dPaused.status === "paused", dPaused.status);
  check("pause: paused mid-flight (2<=iterations<8)",
    dPaused.iterations >= 2 && dPaused.iterations < 8, `iterations=${dPaused.iterations}`);
  const pausedAt = dPaused.iterations;
  await sleep(1200);
  const dStill = await getLoop(d.id);
  check("pause: loop truly halts while paused (no further runs)",
    dStill.status === "paused" && dStill.iterations === pausedAt, `iters ${pausedAt}->${dStill.iterations}`);
  await call("POST", `/api/loops/${d.id}/resume`, { extraIterations: 1 });
  const dDone = await poll(d.id, (l) => l.status === "completed" || l.status === "failed");
  check("pause: resumes and completes", dDone.status === "completed", dDone.status);
  check("pause: finishes all 8 iterations", dDone.iterations === 8, `iterations=${dDone.iterations}`);

  // --- E. stop mid-flight (graceful: the in-flight iteration may finish, but
  //        no NEW iteration starts, and stop is never clobbered) ------------
  const e = await start("[steps=10] should be stopped early", 10);
  await poll(e.id, (l) => l.iterations >= 2 || terminal(l.status), 15000);
  await call("POST", `/api/loops/${e.id}/stop`);
  await poll(e.id, (l) => l.status === "stopped" || l.status === "completed");
  check("stop: reaches stopped state", (await getLoop(e.id)).status === "stopped");
  // Let any in-flight iteration settle, then confirm the loop is fully halted.
  await sleep(2200);
  const s1 = await getLoop(e.id);
  await sleep(2200);
  const s2 = await getLoop(e.id);
  check("stop: not clobbered, stays stopped (no late completed/failed)",
    s2.status === "stopped", s2.status);
  check("stop: fully halts, iterations stable after settle",
    s1.iterations === s2.iterations && (s1.runs?.length ?? 0) === (s2.runs?.length ?? 0),
    `iters ${s1.iterations}->${s2.iterations}, runs ${s1.runs?.length}->${s2.runs?.length}`);
  check("stop: stopped before completing all (iterations<10)",
    s2.iterations < 10, `iterations=${s2.iterations}`);
  check("stop: run rows match iterations (no orphaned/extra run)",
    (s2.runs?.length ?? 0) === s2.iterations, `runs=${s2.runs?.length} iters=${s2.iterations}`);

  // --- F. failure handling ------------------------------------------------
  const f = await start("[fail] this run errors", 3);
  const fFailed = await poll(f.id, (l) => l.status === "failed" || l.status === "completed");
  check("failure: loop marked failed", fFailed.status === "failed", fFailed.status);
  check("failure: last_error recorded", !!fFailed.last_error, fFailed.last_error ?? "");
  check("failure: 1 failed run row", fFailed.runs?.length === 1 && fFailed.runs[0].status === "failed",
    `runs=${fFailed.runs?.length} status=${fFailed.runs?.[0]?.status}`);

  // --- F2. a tool error mid-run must NOT fail the run (agent recovers) -----
  const te = await start("[steps=2][toolerr] recovers from a failed command", 5);
  const teDone = await poll(te.id, (l) => terminal(l.status));
  check("tool-error: loop still completes despite an errored tool call",
    teDone.status === "completed", teDone.status);
  check("tool-error: run rows are completed, not failed",
    teDone.runs?.length === 2 && teDone.runs.every((r: any) => r.status === "completed"),
    `runs=${teDone.runs?.map((r: any) => r.status).join(",")}`);

  // --- G. concurrency + history (no cross-contamination) ------------------
  const [ga, gb, gc] = await Promise.all([
    start("[steps=2] concurrent A", 5),
    start("[steps=2] concurrent B", 5),
    start("[steps=3] concurrent C", 5),
  ]);
  const [gaD, gbD, gcD] = await Promise.all([
    poll(ga.id, (l) => terminal(l.status)),
    poll(gb.id, (l) => terminal(l.status)),
    poll(gc.id, (l) => terminal(l.status)),
  ]);
  check("concurrency: all 3 completed",
    [gaD, gbD, gcD].every((l) => l.status === "completed"),
    [gaD, gbD, gcD].map((l) => l.status).join(","));
  check("concurrency: correct per-loop iteration counts (2,2,3)",
    gaD.iterations === 2 && gbD.iterations === 2 && gcD.iterations === 3,
    `${gaD.iterations},${gbD.iterations},${gcD.iterations}`);
  const noCross = [gaD, gbD, gcD].every(
    (l) => l.runs.length === l.iterations && l.runs.every((r: any) => r.loop_id === l.id),
  );
  check("concurrency: no cross-contamination (each run belongs to its loop)", noCross);
  const allLoops = (await call("GET", "/api/loops")).body;
  check("history: GET /api/loops lists all created loops",
    [gaD, gbD, gcD].every((l) => allLoops.some((x: any) => x.id === l.id)));

  // --- H. resume while running is a no-op (no duplicate runner) ------------
  const h = await start("[steps=4] resume race", 5);
  await sleep(400); // let it get into the running state mid-loop
  await call("POST", `/api/loops/${h.id}/resume`, { extraIterations: 2 });
  await call("POST", `/api/loops/${h.id}/resume`, { extraIterations: 2 });
  const hDone = await poll(h.id, (l) => l.status === "completed" || l.status === "failed");
  check("race: completes cleanly despite spurious resumes", hDone.status === "completed", hDone.status);
  check("race: exactly 4 iterations, no duplicate runs",
    hDone.iterations === 4 && hDone.runs?.length === 4,
    `iterations=${hDone.iterations} runs=${hDone.runs?.length}`);

  // =========================================================================
  // ORCHESTRATED MODE: agents prompting agents
  // =========================================================================
  const orch = (runs: any[]) => runs.filter((r: any) => r.role === "orchestrator");
  const work = (runs: any[]) => runs.filter((r: any) => r.role === "worker");

  // O0. default mode (no mode in the request) is orchestrated
  const dm = (await call("POST", "/api/loops", { goal: "[steps=1] default mode", maxIterations: 3 }))
    .body;
  if (dm?.id) created.add(dm.id);
  check("orchestrated: default mode is orchestrated", dm.mode === "orchestrated", dm.mode);
  await poll(dm.id, (l) => terminal(l.status));

  // O1. a multi-round orchestrated loop completes and the orchestrator spawns workers
  const o1 = await start("[steps=3][fanout=1] orchestrated build", 5, "orchestrated");
  const o1d = await poll(o1.id, (l) => terminal(l.status));
  check("orchestrated: completes", o1d.status === "completed", o1d.status);
  check("orchestrated: 3 rounds", o1d.iterations === 3, `iterations=${o1d.iterations}`);
  check("orchestrated: 3 orchestrator runs, all completed",
    orch(o1d.runs).length === 3 && orch(o1d.runs).every((r: any) => r.status === "completed"),
    `orch=${orch(o1d.runs).length}`);
  check("orchestrated: 2 worker runs (the done round spawns none)",
    work(o1d.runs).length === 2, `workers=${work(o1d.runs).length}`);
  check("orchestrated: every worker links to an orchestrator (parent_run_id)",
    work(o1d.runs).every((w: any) => orch(o1d.runs).some((o: any) => o.id === w.parent_run_id)));
  check("orchestrated: orchestrator runs carry a parsed decision (reasoning)",
    orch(o1d.runs).every((o: any) => !!o.reasoning));

  // O2. fan-out: one orchestrator decision spawns multiple parallel workers
  const o2 = await start("[steps=2][fanout=3] parallel work", 5, "orchestrated");
  const o2d = await poll(o2.id, (l) => terminal(l.status));
  check("fan-out: completes in 2 rounds",
    o2d.status === "completed" && o2d.iterations === 2, `${o2d.status} iters=${o2d.iterations}`);
  check("fan-out: 3 parallel workers spawned", work(o2d.runs).length === 3,
    `workers=${work(o2d.runs).length}`);
  const round1Orch = orch(o2d.runs).find((o: any) => o.iteration === 1);
  check("fan-out: all 3 workers share the same orchestrator parent",
    work(o2d.runs).every((w: any) => w.parent_run_id === round1Orch?.id));
  check("fan-out: all parallel workers completed",
    work(o2d.runs).every((w: any) => w.status === "completed"));

  // O3. cap -> gate -> resume, orchestrated
  const o3 = await start("[steps=5][fanout=1] long orchestrated", 2, "orchestrated");
  const o3cap = await poll(o3.id, (l) => terminal(l.status));
  check("orchestrated gate: parks at awaiting_approval", o3cap.status === "awaiting_approval", o3cap.status);
  check("orchestrated gate: at 2 rounds", o3cap.iterations === 2, `iters=${o3cap.iterations}`);
  await call("POST", `/api/loops/${o3.id}/resume`, { extraIterations: 3 });
  const o3done = await poll(o3.id, (l) => l.status === "completed" || l.status === "failed");
  check("orchestrated gate: completes after resume at 5 rounds",
    o3done.status === "completed" && o3done.iterations === 5, `${o3done.status} iters=${o3done.iterations}`);
  check("orchestrated gate: 5 orchestrator rounds + 4 workers",
    orch(o3done.runs).length === 5 && work(o3done.runs).length === 4,
    `orch=${orch(o3done.runs).length} work=${work(o3done.runs).length}`);

  // O4. orchestrator failure fails the loop and spawns no workers
  const o4 = await start("[orchfail] orchestrator dies", 3, "orchestrated");
  const o4d = await poll(o4.id, (l) => l.status === "failed" || l.status === "completed");
  check("orchestrated: orchestrator failure fails the loop", o4d.status === "failed", o4d.status);
  check("orchestrated: last_error names the orchestrator",
    /orchestrator/i.test(o4d.last_error ?? ""), o4d.last_error ?? "");
  check("orchestrated: no workers spawned on orchestrator failure",
    work(o4d.runs).length === 0, `workers=${work(o4d.runs).length}`);

  // O5. worker failure is non-fatal; the orchestrator still drives to done
  const o5 = await start("[steps=2][fanout=2][workerfail] workers fail", 4, "orchestrated");
  const o5d = await poll(o5.id, (l) => terminal(l.status));
  check("orchestrated: completes even when workers fail", o5d.status === "completed", o5d.status);
  check("orchestrated: the failed workers are recorded",
    work(o5d.runs).length === 2 && work(o5d.runs).every((w: any) => w.status === "failed"),
    `workers=${work(o5d.runs).map((w: any) => w.status).join(",")}`);
  check("orchestrated: orchestrator rounds still completed",
    orch(o5d.runs).every((o: any) => o.status === "completed"));

  // O6. pause mid-flight then resume, orchestrated control flow
  const o6 = await start("[steps=8][fanout=1] pausable orchestrated", 8, "orchestrated");
  await poll(o6.id, (l) => l.iterations >= 2 || terminal(l.status), 25000);
  await call("POST", `/api/loops/${o6.id}/pause`);
  const o6p = await poll(o6.id, (l) => l.status === "paused" || l.status === "completed");
  check("orchestrated pause: reaches paused", o6p.status === "paused", o6p.status);
  check("orchestrated pause: paused mid-flight (2<=rounds<8)",
    o6p.iterations >= 2 && o6p.iterations < 8, `iters=${o6p.iterations}`);
  await call("POST", `/api/loops/${o6.id}/resume`, { extraIterations: 1 });
  const o6done = await poll(o6.id, (l) => l.status === "completed" || l.status === "failed");
  check("orchestrated pause: resumes and completes all 8 rounds",
    o6done.status === "completed" && o6done.iterations === 8, `${o6done.status} iters=${o6done.iterations}`);

  // --- Neon-level integrity check -----------------------------------------
  const runRows = (await sql`
    select count(*)::int as n from runs where loop_id = any(${[...created]})
  `) as Array<{ n: number }>;
  check("neon: runs table has rows for the test loops", (runRows[0]?.n ?? 0) > 0, `rows=${runRows[0]?.n}`);

  // --- Teardown -----------------------------------------------------------
  for (const id of created) {
    await sql`delete from loops where id = ${id}`.catch(() => {});
  }
  console.log(`\nCleaned up ${created.size} test loops (cascades to runs/events).`);

  // --- Summary ------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} checks passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failures:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  (${r.detail})`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("itest crashed:", e);
  process.exit(2);
});
