import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@smart-edu/v3-prisma";
import { getV3Config } from "./config.ts";

type V3Client = InstanceType<typeof PrismaClient>;

const globalForV3 = globalThis as typeof globalThis & {
  v3Prisma?: V3Client;
  v3Pool?: Pool;
};

export function getV3Prisma(): V3Client {
  if (globalForV3.v3Prisma) return globalForV3.v3Prisma;
  const pool = new Pool({
    connectionString: getV3Config().databaseUrl,
    max: process.env.NODE_ENV === "test" ? 2 : 10,
  });
  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  globalForV3.v3Pool = pool;
  globalForV3.v3Prisma = client;
  return client;
}

export async function disconnectV3Prisma(): Promise<void> {
  await globalForV3.v3Prisma?.$disconnect();
  await globalForV3.v3Pool?.end();
  delete globalForV3.v3Prisma;
  delete globalForV3.v3Pool;
}
