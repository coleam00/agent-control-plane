-- Orchestrated mode: an LLM orchestrator agent decides each iteration's tasks
-- and spawns worker agents (agents prompting agents). These columns layer on
-- top of the Ralph-loop schema in 001 and are idempotent.

alter table loops add column if not exists mode text not null default 'orchestrated';
-- mode: 'orchestrated' (orchestrator agent + workers) | 'ralph' (single-agent loop)

alter table runs add column if not exists role text not null default 'worker';
-- role: 'orchestrator' (plans + decides) | 'worker' (executes one task)

alter table runs add column if not exists parent_run_id uuid references runs(id) on delete set null;
-- worker -> the orchestrator run whose decision spawned it

alter table runs add column if not exists reasoning text;
-- orchestrator's decision summary (why these tasks, or why it called the goal done)

create index if not exists runs_parent_idx on runs(parent_run_id);
create index if not exists runs_role_idx on runs(loop_id, role);
