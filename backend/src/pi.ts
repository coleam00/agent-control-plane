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
      if (evt.isError) result.isError = true;
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
