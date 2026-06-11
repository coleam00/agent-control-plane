// Central config, read once from the environment. Bun auto-loads .env.

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

export const config = {
  databaseUrl: req("DATABASE_URL"),
  port: Number(process.env.PORT ?? 8787),

  piBin: process.env.PI_BIN ?? "pi",
  piModel: process.env.PI_MODEL ?? "kimi-coding/kimi-for-coding",
  piTools: (process.env.PI_TOOLS ?? "read,bash,edit,write")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
  piSafetyExt: process.env.PI_SAFETY_EXT ?? "",
  piRunTimeoutS: Number(process.env.PI_RUN_TIMEOUT_S ?? 900),

  workspacesDir: process.env.WORKSPACES_DIR ?? "workspaces",
} as const;
