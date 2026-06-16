import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { LoopMode } from "../types.ts";

export function StartLoopForm({
  onStarted,
  defaultValues,
}: {
  onStarted: () => void;
  defaultValues?: { goal: string; mode: LoopMode; maxIterations: number };
}) {
  const [goal, setGoal] = useState("");
  const [maxIterations, setMaxIterations] = useState(5);
  const [mode, setMode] = useState<LoopMode>("orchestrated");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (defaultValues) {
      setGoal(defaultValues.goal);
      setMode(defaultValues.mode);
      setMaxIterations(defaultValues.maxIterations);
    }
  }, [defaultValues]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await api.startLoop(goal.trim(), maxIterations, mode);
      setGoal("");
      onStarted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="start-form" onSubmit={submit}>
      <input
        className="goal-input"
        placeholder="Goal for the loop, e.g. Build a CLI todo app with tests"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <label className="mode">
        mode
        <select value={mode} onChange={(e) => setMode(e.target.value as LoopMode)}>
          <option value="orchestrated">orchestrated (agents prompting agents)</option>
          <option value="ralph">ralph (single-agent loop)</option>
        </select>
      </label>
      <label className="iter">
        max rounds
        <input
          type="number"
          min={1}
          max={100}
          value={maxIterations}
          onChange={(e) => setMaxIterations(Number(e.target.value))}
        />
      </label>
      <button type="submit" disabled={busy || !goal.trim()}>
        {busy ? "Starting..." : "Start loop"}
      </button>
    </form>
  );
}
