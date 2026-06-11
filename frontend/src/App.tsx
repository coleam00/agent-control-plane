import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { LiveLoopPanel } from "./components/LiveLoopPanel.tsx";
import { RunHistoryTable } from "./components/RunHistoryTable.tsx";
import { StartLoopForm } from "./components/StartLoopForm.tsx";
import type { Loop, Run } from "./types.ts";

const POLL_MS = 2000;

export function App() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([api.listLoops(), api.listRuns()]);
      setLoops(l);
      setRuns(r);
      setError(null);
    } catch (e) {
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

  const totalCost = runs.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

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
          <Stat label="Total cost" value={`$${totalCost.toFixed(4)}`} />
        </div>
      </header>

      {error && <div className="banner error">API error: {error}</div>}

      <StartLoopForm onStarted={refresh} />

      <section>
        <h2>Live loop</h2>
        {active ? (
          <LiveLoopPanel loop={active} runs={activeRuns} onAction={refresh} />
        ) : (
          <p className="muted">No loops yet. Start one above.</p>
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
