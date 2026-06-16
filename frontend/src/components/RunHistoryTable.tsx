import type { Run } from "../types.ts";

export function RunHistoryTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0)
    return (
      <div className="empty-state">
        <span className="empty-state-icon">📋</span>
        <span className="empty-state-title">No runs yet</span>
        <span className="empty-state-sub">Completed agent runs will appear here.</span>
      </div>
    );
  return (
    <table className="history">
      <thead>
        <tr>
          <th>Started</th>
          <th>Round</th>
          <th>Role</th>
          <th>Status</th>
          <th>Result</th>
          <th>Tokens</th>
          <th>Turns</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className={r.status}>
            <td className="nowrap">{fmt(r.started_at)}</td>
            <td>#{r.iteration}</td>
            <td>
              <span className={`badge ${r.role}`}>{r.role}</span>
            </td>
            <td>
              <span className={`pill ${r.status}`}>{r.status}</span>
            </td>
            <td className="result">
              {r.role === "orchestrator" && r.reasoning
                ? r.reasoning.slice(0, 160)
                : (r.output ?? "").replace(/LOOP_STATUS:.*/i, "").trim().slice(0, 160) || "-"}
            </td>
            <td className="nowrap">
              {r.input_tokens ?? "-"} / {r.output_tokens ?? "-"}
            </td>
            <td>{r.num_turns ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
