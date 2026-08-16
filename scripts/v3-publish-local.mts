import { readFile } from "node:fs/promises";
import { disconnectV3Prisma } from "../lib/v3/db.ts";
import { LocalPostgresRecordPublisher, type V3PublishBundle } from "../lib/v3/publisher.ts";

const inputIndex = process.argv.indexOf("--input");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
if (!inputPath) {
  console.error("Usage: node --experimental-strip-types scripts/v3-publish-local.mts --input <bundle.json>");
  process.exit(2);
}

try {
  const bundle = JSON.parse(await readFile(inputPath, "utf8")) as V3PublishBundle;
  const result = await new LocalPostgresRecordPublisher().publish(bundle);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await disconnectV3Prisma();
}
