import { PrismaClient } from "@prisma/client";

/**
 * A single PrismaClient for the process. Reads DATABASE_URL from the environment
 * (the Prisma CLI loads app/.env; tests set it via vitest config + global setup).
 *
 * We force `connection_limit=1` for SQLite: a single writer connection makes the
 * adjudication transaction's sum→decide→insert sequence genuinely serialize across
 * concurrent claims (§ concurrency invariant), instead of two transactions racing
 * the same ledger sum. On Postgres this would instead be a per-row SELECT … FOR
 * UPDATE, letting different members proceed in parallel.
 */
function singleWriterUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) return url;
  return url.includes("connection_limit=")
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

const url = singleWriterUrl();

export const prisma = new PrismaClient({
  ...(url !== undefined && { datasources: { db: { url } } }),
});

export type Db = PrismaClient;

/**
 * SQLite hardening for the running server: WAL lets a reader and the single writer
 * coexist, and busy_timeout makes any lock contention wait briefly instead of
 * throwing SQLITE_BUSY (which would surface as a 500). Best-effort.
 */
export async function configureSqlitePragmas(): Promise<void> {
  if (url && url.startsWith("file:")) {
    // These PRAGMAs return a row (the resulting mode/value), so use queryRaw —
    // executeRaw rejects statements that yield results on SQLite.
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  }
}
