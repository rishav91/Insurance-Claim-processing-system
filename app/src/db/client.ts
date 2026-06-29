import { PrismaClient } from "@prisma/client";

/**
 * A single PrismaClient for the process. Reads DATABASE_URL from the environment
 * (the Prisma CLI loads app/.env; tests set it via vitest config + global setup).
 */
export const prisma = new PrismaClient();

export type Db = PrismaClient;
