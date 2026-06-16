import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { LiveLoopPanel } from "./components/LiveLoopPanel.tsx";
import { RunHistoryTable } from "./components/RunHistoryTable.tsx";
import { StartLoopForm } from "./components/StartLoopForm.tsx";
import type { Loop, LoopPrefill, Run } from "./types.ts";

const POLL_MS = 2000;

export function App() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  // prefill is set by LiveLoopPanel.onRerun and consumed by StartLoopForm via useEffect.
  // It is intentionally never cleared after form submit — a second Re-run click on the
  // same loop creates a new object, re-triggering the effect with the original values.
  const [prefill, setPrefill] = useState<LoopPrefill | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([api.listLoops(), api.listRuns()]);
      setLoops(l);
      setRuns(r);
      setError(null);
    } catch (e) {
      console.error("[refresh]", e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // The "live" loop is the first active one, else the most recently updated.
  const active =
    loops.find((l) =>
      ["running", "awaiting_approval", "paused", "pending"].includes(l.status),
    ) ?? loops[0];
  const activeRuns = active
    ? runs.filter((r) => r.loop_id === active.id).sort((a, b) => a.iteration - b.iteration)
    : [];

  // Pi on a Kimi subscription is flat-rate, so cost.total is always 0.
  // Tokens are the real usage signal, so that's what the dashboard surfaces.
  const totalTokens = runs.reduce(
    (sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );

  return (
    <div className="app">
      <header>
        <div>
          <h1>Agent Control Plane</h1>
          <p className="sub">
            Long-running Pi loops, observed. Every run stored in Neon.
          </p>
        </div>
        <div className="stats">
          <Stat label="Loops" value={String(loops.length)} />
          <Stat label="Runs" value={String(runs.length)} />
          <Stat label="Total tokens" value={totalTokens.toLocaleString()} />
        </div>
      </header>

      {error && <div className="banner error">API error: {error}</div>}

      <StartLoopForm onStarted={refresh} defaultValues={prefill ?? undefined} />

      <section>
        <h2>Live loop</h2>
        {active ? (
          <LiveLoopPanel
            loop={active}
            runs={activeRuns}
            onAction={refresh}
            onRerun={setPrefill}
          />
        ) : (
          <div className="empty-state">
            <span className="empty-state-icon">🤖</span>
            <span className="empty-state-title">No loops yet</span>
            <span className="empty-state-sub">
              Start a loop above to run your first agent task.
            </span>
          </div>
        )}
      </section>

      <section>
        <h2>Run history</h2>
        <RunHistoryTable runs={runs} />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
