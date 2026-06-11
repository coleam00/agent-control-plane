import { useState } from "react";
import { api } from "../api.ts";

export function StartLoopForm({ onStarted }: { onStarted: () => void }) {
  const [goal, setGoal] = useState("");
  const [maxIterations, setMaxIterations] = useState(5);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await api.startLoop(goal.trim(), maxIterations);
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
      <label className="iter">
        max iterations
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
