import { useState } from "react";
import type { Run } from "../types.ts";

export function RunHistoryTable({ runs }: { runs: Run[] }) {
  const [searchText, setSearchText] = useState("");
  const [filterRole, setFilterRole] = useState<"" | "orchestrator" | "worker">("");
  const [filterStatus, setFilterStatus] = useState<"" | "running" | "completed" | "failed">("");

  if (runs.length === 0) return <p className="muted">No runs recorded yet.</p>;

  const q = searchText.toLowerCase();
  const filtered = runs.filter((r) => {
    if (filterRole && r.role !== filterRole) return false;
    if (filterStatus && r.status !== filterStatus) return false;
    if (q) {
      const haystack = [r.task, r.output ?? "", r.reasoning ?? ""].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return (
    <>
      <div className="run-filters">
        <input
          className="run-search"
          aria-label="Search runs"
          placeholder="Search task / result / reasoning…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <label className="mode">
          role
          <select value={filterRole} onChange={(e) => setFilterRole(e.target.value as typeof filterRole)}>
            <option value="">all</option>
            <option value="orchestrator">orchestrator</option>
            <option value="worker">worker</option>
          </select>
        </label>
        <label className="mode">
          status
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}>
            <option value="">all</option>
            <option value="running">running</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </select>
        </label>
      </div>
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
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={8} className="muted" style={{ textAlign: "center", padding: "1rem" }}>
                No runs match the current filters.
              </td>
            </tr>
          ) : (
            filtered.map((r) => (
              <tr key={r.id} className={r.status}>
                <td className="nowrap" title={fmt(r.started_at)}>{relativeTime(r.started_at)}</td>
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
                <td className="nowrap">{duration(r.started_at, r.completed_at)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs <= 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function duration(start: string, end: string | null): string {
  if (!end) return "-";
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "-";
  const secs = Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
