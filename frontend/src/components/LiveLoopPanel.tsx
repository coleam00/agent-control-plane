import { useState } from "react";
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

  const cost = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const canResume = ["awaiting_approval", "paused"].includes(loop.status);
  const canPause = loop.status === "running";

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="goal">{loop.goal}</div>
          <div className="meta">
            <StatusPill status={loop.status} /> · iteration {loop.iterations}/
            {loop.max_iterations} · {loop.model} · ${cost.toFixed(4)}
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
                  "Resume this loop? It will run more paid Pi iterations.",
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

      {loop.last_error && <div className="banner error">{loop.last_error}</div>}

      <ol className="run-list">
        {runs.map((r) => (
          <li key={r.id} className={`run ${r.status}`}>
            <span className="run-iter">#{r.iteration}</span>
            <span className="run-output">
              {(r.output ?? "").replace(/LOOP_STATUS:.*/i, "").trim().slice(0, 220) ||
                "(running...)"}
            </span>
            <span className="run-cost">
              {r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "-"}
            </span>
          </li>
        ))}
        {runs.length === 0 && <li className="muted">Waiting for the first run...</li>}
      </ol>
    </div>
  );
}

function StatusPill({ status }: { status: Loop["status"] }) {
  return <span className={`pill ${status}`}>{status.replace("_", " ")}</span>;
}
