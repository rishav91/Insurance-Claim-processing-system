import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // DB-backed specs share one SQLite file; globalSetup pushes the schema once.
    // Single fork so the single-writer ledger invariant (§ ledger) is exercised
    // on one connection rather than masked by parallel isolation.
    globalSetup: ["./tests/db/global-setup.ts"],
    env: {
      DATABASE_URL: "file:./test.db",
    },
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
