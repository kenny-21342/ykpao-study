/**
 * Migrate SchoolResource rows using the old "From folder upload: <path>"
 * description marker (lib/upload-constants.ts's now-retired
 * FOLDER_UPLOAD_PREFIX) into real SchoolResourceFolder rows + folderId links.
 *
 * Usage:
 *   npx tsx scripts/backfill-school-resource-folders.ts            # dry run, report only
 *   npx tsx scripts/backfill-school-resource-folders.ts --apply
 *
 * Read the dry-run report before applying: it lists every distinct path this
 * would resolve into folders and how many resources land in each, so a typo'd
 * or wildly inconsistent path (e.g. mixed slash/backslash from a Windows
 * upload) can be caught before it mints a folder for it.
 *
 * Idempotent: a resource whose description no longer starts with the marker
 * (because a previous --apply run already cleared it) is skipped, so this can
 * be re-run safely if it's interrupted partway through.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { resolveFolderPath } from '../lib/school-resources';

const FOLDER_UPLOAD_PREFIX = 'From folder upload: ';
const APPLY = process.argv.includes('--apply');

function stripFileNameFromPath(path: string, fileName: string): string {
  const segments = path.split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return '';
  if (segments[segments.length - 1].toLowerCase() === fileName.toLowerCase()) {
    return segments.slice(0, -1).join('/');
  }
  return segments.join('/');
}

async function main() {
  const candidates = await prisma.schoolResource.findMany({
    where: { description: { startsWith: FOLDER_UPLOAD_PREFIX } },
    select: { id: true, description: true, fileName: true },
  });

  if (candidates.length === 0) {
    console.log('No resources carry the old folder-upload marker. Nothing to do.');
    return;
  }

  const byPath = new Map<string, string[]>();
  for (const resource of candidates) {
    const rawPath = resource.description.slice(FOLDER_UPLOAD_PREFIX.length).trim();
    const folderPath = stripFileNameFromPath(rawPath, resource.fileName);
    if (!folderPath) continue;
    const list = byPath.get(folderPath) ?? [];
    list.push(resource.id);
    byPath.set(folderPath, list);
  }

  console.log(`${candidates.length} resources carry the old marker, resolving to ${byPath.size} distinct folder paths:\n`);
  for (const [path, ids] of [...byPath.entries()].sort()) {
    console.log(`  ${ids.length.toString().padStart(4)}  ${path}`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to create these folders and link the resources.');
    return;
  }

  console.log('\nApplying...');
  let linked = 0;
  for (const [path, ids] of byPath.entries()) {
    const folderId = await resolveFolderPath(path);
    if (!folderId) continue;
    const result = await prisma.schoolResource.updateMany({
      where: { id: { in: ids } },
      data: { folderId, description: '' },
    });
    linked += result.count;
    console.log(`  linked ${result.count} resource(s) to "${path}"`);
  }
  console.log(`\nDone. ${linked} resources linked to real folders.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
