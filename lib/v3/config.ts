import path from "node:path";

const DEFAULT_DATABASE_URL = "postgresql://smart_edu_v3:smart_edu_v3_local@127.0.0.1:55432/smart_edu_v3?sslmode=disable";

export type V3Config = {
  databaseUrl: string;
  assetRoot: string;
  workRoot: string;
  manifestRoot: string;
};

export function isV3Enabled(): boolean {
  if (process.env.V3_ENABLED === "false") return false;
  return process.env.NODE_ENV !== "production" || process.env.V3_ENABLED === "true";
}

export function getV3Config(): V3Config {
  if (!isV3Enabled()) throw new Error("V3 is disabled in this environment");
  return {
    databaseUrl: process.env.V3_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    assetRoot: resolveLocalRoot(process.env.V3_ASSET_ROOT ?? "data/v3/assets"),
    workRoot: resolveLocalRoot(process.env.V3_WORK_ROOT ?? "data/v3/work"),
    manifestRoot: resolveLocalRoot(process.env.V3_MANIFEST_ROOT ?? "data/v3/manifests"),
  };
}

function resolveLocalRoot(value: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), value);
}
