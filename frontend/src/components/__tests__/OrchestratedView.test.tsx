import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrchestratedView } from "../LiveLoopPanel";
import type { Run } from "../../types";

const makeOrch = (id: string, iteration: number): Run => ({
  id,
  loop_id: "loop-1",
  role: "orchestrator",
  iteration,
  status: "completed",
  parent_run_id: null,
  reasoning: `Reasoning for round ${iteration}`,
  task: "",
  output: null,
  model: null,
  cost_usd: null,
  input_tokens: null,
  output_tokens: null,
  num_turns: null,
  session_id: null,
  started_at: "2026-01-01T00:00:00Z",
  completed_at: null,
});

const makeWorker = (id: string, parentId: string): Run => ({
  id,
  loop_id: "loop-1",
  role: "worker",
  iteration: 1,
  status: "completed",
  parent_run_id: parentId,
  reasoning: null,
  task: "Do work",
  output: "Done",
  model: null,
  cost_usd: null,
  input_tokens: 10,
  output_tokens: 20,
  num_turns: null,
  session_id: null,
  started_at: "2026-01-01T00:00:00Z",
  completed_at: null,
});

describe("OrchestratedView", () => {
  it("renders latest round open by default", () => {
    const runs = [
      makeOrch("orch-1", 1),
      makeOrch("orch-2", 2),
      makeWorker("w-1", "orch-2"),
    ];
    render(<OrchestratedView runs={runs} />);
    expect(screen.getByText("Do work")).toBeInTheDocument();
  });

  it("collapses latest round when chevron clicked", () => {
    const runs = [makeOrch("orch-1", 1), makeWorker("w-1", "orch-1")];
    render(<OrchestratedView runs={runs} />);
    expect(screen.getByText("Do work")).toBeInTheDocument();

    fireEvent.click(screen.getByText("▼"));
    expect(screen.queryByText("Do work")).not.toBeInTheDocument();
  });

  it("re-opens a collapsed round when chevron clicked again", () => {
    const runs = [makeOrch("orch-1", 1), makeWorker("w-1", "orch-1")];
    render(<OrchestratedView runs={runs} />);
    fireEvent.click(screen.getByText("▼"));
    expect(screen.queryByText("Do work")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("▶"));
    expect(screen.getByText("Do work")).toBeInTheDocument();
  });

  it("handles empty orchestrators array without crashing", () => {
    render(<OrchestratedView runs={[]} />);
    expect(document.querySelector(".rounds")).toBeInTheDocument();
  });

  it("only shows workers under their parent round", () => {
    const runs = [
      makeOrch("orch-1", 1),
      makeOrch("orch-2", 2),
      makeWorker("w-1", "orch-1"),
      makeWorker("w-2", "orch-2"),
    ];
    render(<OrchestratedView runs={runs} />);
    // Only orch-2 (latest) is open by default; only w-2 should be visible
    expect(screen.getByText("Do work")).toBeInTheDocument();
    // There is exactly one "Do work" visible (w-2 under orch-2)
    expect(screen.getAllByText("Do work")).toHaveLength(1);
  });
});
