-- Agent Control Plane schema (Neon / Postgres).
-- Mirrors the shape of the Archon run model (remote_agent_workflow_runs /
-- _events) so the dashboard lines up with that harness.

create table if not exists loops (
  id             uuid primary key default gen_random_uuid(),
  goal           text        not null,
  status         text        not null default 'pending',
  -- pending | running | awaiting_approval | paused | completed | failed | stopped
  max_iterations int         not null default 10,
  iterations     int         not null default 0,
  model          text,
  workspace      text,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists runs (
  id            uuid primary key default gen_random_uuid(),
  loop_id       uuid        references loops(id) on delete cascade,
  iteration     int         not null default 0,
  task          text        not null,
  status        text        not null default 'running',
  -- running | completed | failed
  output        text,
  model         text,
  cost_usd      double precision,
  input_tokens  int,
  output_tokens int,
  num_turns     int,
  session_id    text,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create table if not exists run_events (
  id         bigserial primary key,
  run_id     uuid references runs(id) on delete cascade,
  loop_id    uuid references loops(id) on delete cascade,
  event_type text        not null,
  -- tool_start | tool_end | text | turn_end | error | status
  detail     jsonb       not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists runs_loop_idx       on runs(loop_id, iteration);
create index if not exists runs_started_idx     on runs(started_at desc);
create index if not exists run_events_run_idx    on run_events(run_id, id);
create index if not exists loops_updated_idx     on loops(updated_at desc);
