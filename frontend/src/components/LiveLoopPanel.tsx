import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Loop, Run } from "../types.ts";

export function LiveLoopPanel({
  loop,
  runs,
  onAction,
}: {
  loop: Loop;
  runs: Run[];
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await fn();
      onAction();
    } finally {
      setBusy(false);
    }
  };

  // Kimi is flat-rate (cost is always 0), so the loop summary surfaces tokens.
  const loopTokens = runs.reduce(
    (s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );
  const canResume = ["awaiting_approval", "paused"].includes(loop.status);
  const canPause = loop.status === "running";
  const elapsed = useElapsed(loop.created_at, loop.status === "running");
  const pct = computePct(loop.iterations, loop.max_iterations);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="goal">{loop.goal}</div>
          <div className="meta">
            <StatusPill status={loop.status} /> · <span className="mode-tag">{loop.mode}</span> ·
            round {loop.iterations}/{loop.max_iterations} ·{" "}
            {loop.status === "running" && elapsed && `running for ${elapsed} · `}
            {loop.model} · {loopTokens.toLocaleString()} tokens
          </div>
        </div>
        <div className="actions">
          {canPause && (
            <button disabled={busy} onClick={() => act(() => api.pauseLoop(loop.id))}>
              Pause
            </button>
          )}
          {canResume && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                act(
                  () => api.resumeLoop(loop.id, 5),
                  "Resume this loop? It will run more paid agent rounds.",
                )
              }
            >
              Approve &amp; resume
            </button>
          )}
          <button
            className="danger"
            disabled={busy || ["completed", "stopped", "failed"].includes(loop.status)}
            onClick={() => act(() => api.stopLoop(loop.id), "Stop this loop?")}
          >
            Stop
          </button>
        </div>
      </div>

      <div className="progress-bar">
        <div
          className="progress-bar-fill"
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      </div>

      {loop.last_error && <div className="banner error">{loop.last_error}</div>}

      {runs.length === 0 ? (
        <p className="muted">Waiting for the first round...</p>
      ) : loop.mode === "orchestrated" ? (
        <OrchestratedView runs={runs} />
      ) : (
        <FlatView runs={runs} />
      )}
    </div>
  );
}

// Orchestrated: each orchestrator decision, then the workers it spawned.
export function OrchestratedView({ runs }: { runs: Run[] }) {
  const orchestrators = runs.filter((r) => r.role === "orchestrator");
  const workersByParent = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.role === "worker" && r.parent_run_id) {
      const list = workersByParent.get(r.parent_run_id) ?? [];
      list.push(r);
      workersByParent.set(r.parent_run_id, list);
    }
  }
  const latestOrchId = orchestrators.at(-1)?.id ?? "";
  const [openRounds, setOpenRounds] = useState<Set<string>>(
    () => new Set(latestOrchId ? [latestOrchId] : []),
  );
  // Auto-expand each new round as the loop progresses.
  useEffect(() => {
    if (latestOrchId) {
      setOpenRounds((prev) => {
        if (prev.has(latestOrchId)) return prev;
        return new Set([...prev, latestOrchId]);
      });
    }
  }, [latestOrchId]);
  const toggleRound = (id: string) =>
    setOpenRounds((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  return (
    <div className="rounds">
      {orchestrators.map((orch) => {
        const workers = workersByParent.get(orch.id) ?? [];
        const open = openRounds.has(orch.id);
        return (
          <div key={orch.id} className="round">
            <div
              className={`orch ${orch.status}`}
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => toggleRound(orch.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleRound(orch.id);
                }
              }}
            >
              <span className="round-chevron">{open ? "▼" : "▶"}</span>
              <span className="badge orchestrator">orchestrator</span>
              <span className="round-num">round {orch.iteration}</span>
              <span className="orch-reason">
                {orch.reasoning ||
                  (orch.status === "running" ? "(deciding...)" : "(no decision parsed)")}
              </span>
            </div>
            {workers.length > 0 && open && (
              <ul className="workers">
                {workers.map((w) => (
                  <li key={w.id} className={`worker ${w.status}`}>
                    <span className="badge worker">worker</span>
                    <span className="worker-task">{w.task}</span>
                    <span className="run-cost">{tokens(w)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Ralph: a flat list of single-agent iterations.
function FlatView({ runs }: { runs: Run[] }) {
  return (
    <ol className="run-list">
      {runs.map((r) => (
        <li key={r.id} className={`run ${r.status}`}>
          <span className="run-iter">#{r.iteration}</span>
          <span className="run-output">
            {(r.output ?? "").replace(/LOOP_STATUS:.*/i, "").trim().slice(0, 220) ||
              "(running...)"}
          </span>
          <span className="run-cost">{tokens(r)}</span>
        </li>
      ))}
    </ol>
  );
}

// Live elapsed time since `createdAt`, recomputed each tick (drift-free).
// Returns "" when inactive so the caller can hide the display.
export function useElapsed(createdAt: string, active: boolean): string {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    if (!active) {
      setElapsed("");
      return;
    }
    const start = Date.parse(createdAt);
    if (isNaN(start)) return;
    const update = () => {
      setElapsed(formatElapsed(Math.floor((Date.now() - start) / 1000)));
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [createdAt, active]);
  return elapsed;
}

export function formatElapsed(total: number): string {
  const s = Math.max(0, total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function computePct(iterations: number, maxIterations: number): number {
  return maxIterations > 0 ? Math.min(100, (iterations / maxIterations) * 100) : 0;
}

function tokens(r: Run): string {
  if (r.input_tokens == null && r.output_tokens == null) return "-";
  return `${r.input_tokens ?? 0}/${r.output_tokens ?? 0} tok`;
}

function StatusPill({ status }: { status: Loop["status"] }) {
  return <span className={`pill ${status}`}>{status.replace("_", " ")}</span>;
}
