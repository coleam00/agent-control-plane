// Apply the schema to the configured Neon database. Idempotent.
import { initSchema } from "./db.ts";

await initSchema();
console.log("Schema applied to Neon. Tables: loops, runs, run_events.");
process.exit(0);
