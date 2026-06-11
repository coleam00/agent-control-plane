// End-to-end smoke test, no HTTP server needed:
//   1. confirm the Neon connection + schema,
//   2. run a single Pi task in a temp workspace and print the parsed result.
// Run: bun run smoke
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";
import { initSchema, sql } from "./db.ts";
import { runPiTask } from "./pi.ts";

console.log("1. Applying schema / checking Neon connection...");
await initSchema();
const rows = (await sql`select count(*)::int as count from runs`) as Array<{
  count: number;
}>;
console.log(`   Neon OK. runs table has ${rows[0]?.count ?? 0} row(s).`);

console.log(`2. Running one Pi task (model ${config.piModel})...`);
const ws = await mkdtemp(join(tmpdir(), "acp-smoke-"));
const result = await runPiTask(
  "Respond with exactly one line: PI OK. Do not use any tools.",
  { cwd: ws, tools: [], timeoutS: 120 },
);
console.log("   output:    ", JSON.stringify(result.output.slice(0, 200)));
console.log("   cost_usd:  ", result.costUsd);
console.log("   tokens:    ", result.inputTokens, "/", result.outputTokens);
console.log("   turns:     ", result.numTurns);
console.log("   isError:   ", result.isError, result.errorDetail);

process.exit(result.isError ? 1 : 0);
