import type { Run } from "../types.ts";

export function RunHistoryTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <p className="muted">No runs recorded yet.</p>;
  return (
    <table className="history">
      <thead>
        <tr>
          <th>Started</th>
          <th>Iter</th>
          <th>Status</th>
          <th>Result</th>
          <th>Tokens</th>
          <th>Cost</th>
          <th>Turns</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className={r.status}>
            <td className="nowrap">{fmt(r.started_at)}</td>
            <td>#{r.iteration}</td>
            <td>
              <span className={`pill ${r.status}`}>{r.status}</span>
            </td>
            <td className="result">
              {(r.output ?? "").replace(/LOOP_STATUS:.*/i, "").trim().slice(0, 160) || "-"}
            </td>
            <td className="nowrap">
              {r.input_tokens ?? "-"} / {r.output_tokens ?? "-"}
            </td>
            <td>{r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "-"}</td>
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
