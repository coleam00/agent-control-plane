export type LoopStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export interface Loop {
  id: string;
  goal: string;
  status: LoopStatus;
  max_iterations: number;
  iterations: number;
  model: string | null;
  workspace: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  loop_id: string | null;
  iteration: number;
  task: string;
  status: "running" | "completed" | "failed";
  output: string | null;
  model: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  num_turns: number | null;
  session_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface LoopDetail extends Loop {
  runs: Run[];
}
