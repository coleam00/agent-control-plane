import { useState } from "react";
import { api } from "../api.ts";
import type { Loop, LoopMode, Run } from "../types.ts";

export function LiveLoopPanel({
  loop,
  runs,
  onAction,
  onRerun,
}: {
  loop: Loop;
  runs: Run[];
  onAction: () => void;
  onRerun?: (prefill: { goal: string; mode: LoopMode; maxIterations: number }) => void;
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
  const canRerun = ["completed", "stopped", "failed"].includes(loop.status);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="goal">{loop.goal}</div>
          <div className="meta">
            <StatusPill status={loop.status} /> · <span className="mode-tag">{loop.mode}</span> ·
            round {loop.iterations}/{loop.max_iterations} · {loop.model} ·{" "}
            {loopTokens.toLocaleString()} tokens
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
          {canRerun && (
            <button
              disabled={busy}
              onClick={() =>
                onRerun?.({
                  goal: loop.goal,
                  mode: loop.mode,
                  maxIterations: loop.max_iterations,
                })
              }
            >
              Re-run
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

      {loop.last_error && <div className="banner error">{loop.last_error}</div>}

      {runs.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">⏳</span>
          <span className="empty-state-title">Waiting for the first round</span>
          <span className="empty-state-sub">The agent is starting up…</span>
        </div>
      ) : loop.mode === "orchestrated" ? (
        <OrchestratedView runs={runs} />
      ) : (
        <FlatView runs={runs} />
      )}
    </div>
  );
}

// Orchestrated: each orchestrator decision, then the workers it spawned.
function OrchestratedView({ runs }: { runs: Run[] }) {
  const orchestrators = runs.filter((r) => r.role === "orchestrator");
  const workersByParent = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.role === "worker" && r.parent_run_id) {
      const list = workersByParent.get(r.parent_run_id) ?? [];
      list.push(r);
      workersByParent.set(r.parent_run_id, list);
    }
  }
  return (
    <div className="rounds">
      {orchestrators.map((orch) => {
        const workers = workersByParent.get(orch.id) ?? [];
        return (
          <div key={orch.id} className="round">
            <div className={`orch ${orch.status}`}>
              <span className="badge orchestrator">orchestrator</span>
              <span className="round-num">round {orch.iteration}</span>
              <span className="orch-reason">
                {orch.reasoning ||
                  (orch.status === "running" ? "(deciding...)" : "(no decision parsed)")}
              </span>
            </div>
            {workers.length > 0 && (
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

function tokens(r: Run): string {
  if (r.input_tokens == null && r.output_tokens == null) return "-";
  return `${r.input_tokens ?? 0}/${r.output_tokens ?? 0} tok`;
}

function StatusPill({ status }: { status: Loop["status"] }) {
  return <span className={`pill ${status}`}>{status.replace("_", " ")}</span>;
}
