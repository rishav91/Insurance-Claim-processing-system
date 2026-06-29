import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Vitest globalSetup: build a fresh SQLite schema for the test run.
 * DATABASE_URL is also set in vitest.config.ts `env` so worker processes (where
 * PrismaClient instantiates) point at the same file. The relative `file:` path is
 * resolved against prisma/schema.prisma → prisma/test.db.
 *
 * We delete the test DB file up front (a throwaway local file) and then run a plain
 * `prisma db push` — no `--force-reset`, which keeps it free of data-loss prompts.
 */
const TEST_DATABASE_URL = "file:./test.db";

export default function setup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dbPath = resolve(here, "../../prisma/test.db");
  for (const f of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
    rmSync(f, { force: true });
  }

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  execSync("npx prisma db push --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
