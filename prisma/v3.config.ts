import "dotenv/config";
import { defineConfig } from "prisma/config";

// Convenience default for the docker-compose dev database only. Falling back
// to it in production would silently point a deploy at a localhost port that
// either refuses the connection or — worse — belongs to something else.
const localUrl = "postgresql://smart_edu_v3:smart_edu_v3_local@127.0.0.1:55432/smart_edu_v3?sslmode=disable";

/**
 * A syntactically valid URL that cannot connect to anything.
 *
 * `prisma generate` needs *a* datasource URL to build the client, but never
 * opens a connection. When V3 is switched off, the client is still generated
 * (the /v3 route handlers have to compile) while no code path can reach a
 * database — so a placeholder is honest here, and a throw is not.
 */
const disabledUrl = "postgresql://v3-disabled/v3-disabled";

/**
 * Mirrors `isV3Enabled()` in lib/v3/config.ts. Kept as a copy rather than an
 * import: this file is loaded by the Prisma CLI, outside the app's module
 * resolution, so pulling in `@/lib` here is not reliable. Change both together.
 */
function isV3Enabled(): boolean {
  if (process.env.V3_ENABLED === "false") return false;
  return process.env.NODE_ENV !== "production" || process.env.V3_ENABLED === "true";
}

function resolveDatasourceUrl(): string {
  const url = process.env.V3_DATABASE_URL;
  if (url) return url;

  // Deliberately not a throw. `prebuild` runs `v3:generate`, and a production
  // build has NODE_ENV=production with no .env file — so throwing here failed
  // the whole Vercel build of a deployment that had correctly disabled V3.
  if (!isV3Enabled()) return disabledUrl;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "V3_DATABASE_URL must be set in production when V3_ENABLED=true; " +
        "refusing to fall back to the local dev database. Set V3_ENABLED=false " +
        "to ship without the corpus tool.",
    );
  }
  return localUrl;
}

export default defineConfig({
  schema: "v3/schema.prisma",
  migrations: {
    path: "v3/migrations",
  },
  datasource: {
    url: resolveDatasourceUrl(),
  },
});
