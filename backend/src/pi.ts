// Pi driver. Runs the `pi` coding agent headless in JSON mode and parses its
// event stream. This mirrors the proven invocation in the second brain's
// pi_sdk_compat.py (pi --mode json --print, LF-delimited JSON events), so the
// control plane runs Pi exactly the way the rest of the system already does.
//
// Verified against pi 0.79.1. The event contract:
//   {type:"session", id}
//   {type:"tool_execution_start"/"tool_execution_end", toolName, isError}
//   {type:"message_update", assistantMessageEvent:{type, delta, ...}}
//   {type:"message_end", message:{role, content:[{type:"text",text}], usage:{input,output,cost:{total}}, stopReason}}
//   {type:"turn_end"}
//   {type:"agent_end", messages:[...]}  (fallback for final text)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";

export interface PiEvent {
  type: string;
  detail: Record<string, unknown>;
}

export interface PiResult {
  output: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number;
  sessionId: string | null;
  isError: boolean;
  errorDetail: string;
}

export interface PiRunOptions {
  cwd: string;
  model?: string;
  tools?: string[];
  timeoutS?: number;
  onEvent?: (e: PiEvent) => void;
}

function textFromMessage(msg: Record<string, unknown>): string {
  const content = (msg.content as Array<Record<string, unknown>>) ?? [];
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function runPiTask(
  prompt: string,
  opts: PiRunOptions,
): Promise<PiResult> {
  // Deterministic test mode: skip the real agent, simulate an increment fast.
  // Gated on ACP_FAKE_PI so it can never fire in normal operation.
  if (process.env.ACP_FAKE_PI === "1") return fakePiRun(prompt, opts);

  const model = opts.model ?? config.piModel;
  const tools = opts.tools ?? config.piTools;
  const timeoutS = opts.timeoutS ?? config.piRunTimeoutS;

  // Pass the prompt via @file to dodge argv length limits (same as the Python).
  const dir = await mkdtemp(join(tmpdir(), "acp-pi-"));
  const promptFile = join(dir, "prompt.md");
  await Bun.write(promptFile, prompt);

  const cmd = [config.piBin, "--mode", "json", "--print", "--model", model, "--no-session"];
  if (tools.length > 0) {
    cmd.push("--tools", tools.join(","));
    const touchesFs = tools.some((t) => ["bash", "edit", "write"].includes(t));
    if (touchesFs && config.piSafetyExt) cmd.push("-e", config.piSafetyExt);
  } else {
    cmd.push("--no-tools", "--no-skills", "--no-context-files");
  }
  cmd.push("@" + promptFile);

  const result: PiResult = {
    output: "",
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 0,
    sessionId: null,
    isError: false,
    errorDetail: "",
  };

  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const killTimer = setTimeout(() => {
    result.isError = true;
    result.errorDetail = `pi timed out after ${timeoutS}s`;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, timeoutS * 1000);

  const emit = (type: string, detail: Record<string, unknown>) =>
    opts.onEvent?.({ type, detail });

  try {
    const decoder = new TextDecoder();
    let buf = "";
    // Bun's stdout is an async-iterable ReadableStream of byte chunks.
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        handleEvent(evt, result, emit);
      }
    }
  } finally {
    clearTimeout(killTimer);
  }

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (!result.output && (exitCode !== 0 || result.isError)) {
    result.isError = true;
    result.errorDetail =
      result.errorDetail || stderr.slice(-500).trim() || `pi exited ${exitCode}`;
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return result;
}

// Fast, deterministic stand-in for a real Pi run, used only by the integration
// tests (ACP_FAKE_PI=1). It reads control tokens out of the prompt and keeps a
// counter on disk (proving cross-iteration state). Tokens (set in the loop
// goal): `[steps=N]` finish after N rounds, `[fanout=K]` K parallel workers per
// round, `[fail]`/`[orchfail]` Pi-level failure, `[workerfail]` worker errors
// (non-fatal), `[toolerr]` a recovered tool error. It detects which role it is
// playing from the prompt, so orchestrated and ralph loops both work.
async function fakePiRun(prompt: string, opts: PiRunOptions): Promise<PiResult> {
  if (/You are the orchestrator agent/.test(prompt)) return fakeOrchestrator(prompt, opts);
  if (/You are a worker agent/.test(prompt)) return fakeWorker(prompt, opts);
  return fakeRalph(prompt, opts);
}

async function bumpCounter(cwd: string, file: string): Promise<number> {
  const path = join(cwd, file);
  let count = 0;
  try {
    count = Number((await Bun.file(path).text()).trim()) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  await Bun.write(path, String(count));
  return count;
}

function fakeResult(output: string, n: number, isError = false, errorDetail = ""): PiResult {
  return {
    output,
    costUsd: 0,
    inputTokens: 100 + n,
    outputTokens: 20,
    numTurns: 1,
    sessionId: `fake-${n}`,
    isError,
    errorDetail,
  };
}

async function fakeRalph(prompt: string, opts: PiRunOptions): Promise<PiResult> {
  opts.onEvent?.({ type: "tool_start", detail: { toolName: "bash" } });
  const count = await bumpCounter(opts.cwd, "_fake_count.txt");
  opts.onEvent?.({ type: "tool_end", detail: { toolName: "bash", isError: false } });
  if (/\[toolerr\]/.test(prompt)) {
    opts.onEvent?.({ type: "tool_end", detail: { toolName: "bash", isError: true } });
  }
  await new Promise((r) => setTimeout(r, 120));
  if (/\[fail\]/.test(prompt)) return fakeResult("", count, true, "simulated Pi failure");

  const steps = Number(prompt.match(/\[steps=(\d+)\]/)?.[1] ?? 1);
  const done = count >= steps;
  const output = `Fake increment ${count} of ${steps}. LOOP_STATUS: ${done ? "DONE" : "CONTINUE"}`;
  opts.onEvent?.({ type: "text", detail: { preview: output } });
  opts.onEvent?.({ type: "turn_end", detail: { turn: 1 } });
  return fakeResult(output, count);
}

async function fakeOrchestrator(prompt: string, opts: PiRunOptions): Promise<PiResult> {
  opts.onEvent?.({ type: "tool_start", detail: { toolName: "read" } });
  const round = await bumpCounter(opts.cwd, "_orch_count.txt");
  opts.onEvent?.({ type: "tool_end", detail: { toolName: "read", isError: false } });
  await new Promise((r) => setTimeout(r, 100));
  if (/\[orchfail\]/.test(prompt)) return fakeResult("", round, true, "simulated orchestrator failure");

  const steps = Number(prompt.match(/\[steps=(\d+)\]/)?.[1] ?? 1);
  const fanout = Math.max(1, Number(prompt.match(/\[fanout=(\d+)\]/)?.[1] ?? 1));
  let decision: string;
  if (round >= steps) {
    decision = `{"status": "done", "reasoning": "fake: goal met after ${round} rounds", "tasks": []}`;
  } else {
    const tasks = Array.from({ length: fanout }, (_, i) => `fake task ${round}.${i + 1}`);
    decision = `{"status": "continue", "reasoning": "fake round ${round}", "tasks": ${JSON.stringify(tasks)}}`;
  }
  const output = `Round ${round} decision.\n\`\`\`json\n${decision}\n\`\`\``;
  opts.onEvent?.({ type: "text", detail: { preview: output.slice(0, 120) } });
  opts.onEvent?.({ type: "turn_end", detail: { turn: 1 } });
  return fakeResult(output, round);
}

async function fakeWorker(prompt: string, opts: PiRunOptions): Promise<PiResult> {
  opts.onEvent?.({ type: "tool_start", detail: { toolName: "bash" } });
  const n = await bumpCounter(opts.cwd, "_work_count.txt");
  opts.onEvent?.({ type: "tool_end", detail: { toolName: "bash", isError: false } });
  if (/\[toolerr\]/.test(prompt)) {
    opts.onEvent?.({ type: "tool_end", detail: { toolName: "bash", isError: true } });
  }
  await new Promise((r) => setTimeout(r, 100));
  if (/\[workerfail\]/.test(prompt)) return fakeResult("", n, true, "simulated worker failure");
  const output = `Worker completed its task (#${n}).`;
  opts.onEvent?.({ type: "text", detail: { preview: output } });
  opts.onEvent?.({ type: "turn_end", detail: { turn: 1 } });
  return fakeResult(output, n);
}

function handleEvent(
  evt: Record<string, unknown>,
  result: PiResult,
  emit: (type: string, detail: Record<string, unknown>) => void,
): void {
  const type = String(evt.type ?? "");
  switch (type) {
    case "session": {
      result.sessionId = (evt.id as string) ?? result.sessionId;
      break;
    }
    case "tool_execution_start": {
      emit("tool_start", { toolName: evt.toolName });
      break;
    }
    case "tool_execution_end": {
      // A single errored tool call (a failing test, a nonzero command) is
      // normal agent behavior, the agent typically recovers and retries. It
      // must NOT fail the whole run. Surface it as an event for the dashboard,
      // but only genuine Pi-level failures (stopReason error, nonzero exit,
      // timeout) mark result.isError below.
      emit("tool_end", { toolName: evt.toolName, isError: !!evt.isError });
      break;
    }
    case "message_update": {
      const ev = (evt.assistantMessageEvent as Record<string, unknown>) ?? {};
      if (ev.type === "error") {
        result.isError = true;
        result.errorDetail = String(ev.reason ?? result.errorDetail);
      }
      break;
    }
    case "message_end": {
      const msg = (evt.message as Record<string, unknown>) ?? {};
      if (msg.role === "assistant") {
        const text = textFromMessage(msg);
        if (text.trim()) result.output = text;
        const usage = (msg.usage as Record<string, unknown>) ?? {};
        const cost = (usage.cost as Record<string, unknown>) ?? {};
        const c = num(cost.total);
        if (c !== null) result.costUsd = (result.costUsd ?? 0) + c;
        const inTok = num(usage.input) ?? num(usage.input_tokens);
        const outTok = num(usage.output) ?? num(usage.output_tokens);
        if (inTok !== null) result.inputTokens = (result.inputTokens ?? 0) + inTok;
        if (outTok !== null) result.outputTokens = (result.outputTokens ?? 0) + outTok;
        if (msg.stopReason === "error") {
          result.isError = true;
          result.errorDetail = String(msg.errorMessage ?? result.errorDetail);
        }
        emit("text", { preview: text.slice(0, 280) });
      }
      break;
    }
    case "turn_end": {
      result.numTurns += 1;
      emit("turn_end", { turn: result.numTurns });
      break;
    }
    case "agent_end": {
      if (!result.output) {
        const messages = (evt.messages as Array<Record<string, unknown>>) ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]!;
          if (m.role === "assistant") {
            const t = textFromMessage(m);
            if (t) {
              result.output = t;
              break;
            }
          }
        }
      }
      break;
    }
    default:
      break;
  }
}
