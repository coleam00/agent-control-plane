import { useState } from "react";
import type { Run, RunRole } from "../types.ts";

export function RunHistoryTable({ runs }: { runs: Run[] }) {
  const [roleFilter, setRoleFilter] = useState<"" | RunRole>("");
  const [statusFilter, setStatusFilter] = useState<"" | Run["status"]>("");
  const [search, setSearch] = useState("");

  if (runs.length === 0) return <p className="muted">No runs recorded yet.</p>;

  const filtered = runs.filter((r) => {
    if (roleFilter && r.role !== roleFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = [r.task, r.output ?? "", r.reasoning ?? ""].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return (
    <>
      <div className="history-filters">
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as "" | RunRole)}>
          <option value="">All roles</option>
          <option value="orchestrator">Orchestrator</option>
          <option value="worker">Worker</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | Run["status"])}>
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <input
          className="history-search"
          type="text"
          placeholder="Search task / result…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <p className="muted">No runs match the current filters.</p>
      ) : (
        <table className="history">
          <thead>
            <tr>
              <th>Started</th>
              <th>Round</th>
              <th>Role</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Result</th>
              <th>Tokens</th>
              <th>Turns</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const ts = relFmt(r.started_at);
              return (
                <tr key={r.id} className={r.status}>
                  <td className="nowrap" title={ts.title}>
                    {ts.label}
                  </td>
                  <td>#{r.iteration}</td>
                  <td>
                    <span className={`badge ${r.role}`}>{r.role}</span>
                  </td>
                  <td>
                    <span className={`pill ${r.status}`}>{r.status}</span>
                  </td>
                  <td className="nowrap">{duration(r)}</td>
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
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function relFmt(iso: string): { label: string; title: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: iso, title: iso };
  const title = d.toLocaleString();
  const delta = Date.now() - d.getTime();
  if (delta < 60_000) return { label: `${Math.floor(delta / 1000)}s ago`, title };
  if (delta < 3_600_000) return { label: `${Math.floor(delta / 60_000)}m ago`, title };
  if (delta < 86_400_000) return { label: `${Math.floor(delta / 3_600_000)}h ago`, title };
  return { label: `${Math.floor(delta / 86_400_000)}d ago`, title };
}

function duration(r: Run): string {
  if (r.completed_at == null) return "-";
  const ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
  if (Number.isNaN(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
