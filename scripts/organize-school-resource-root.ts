/**
 * File legacy root resources into Subject/Category/Year/Month folders.
 * Existing folder uploads and resources already in folders are left alone.
 *
 * Dry run: npx tsx scripts/organize-school-resource-root.ts
 * Apply:   npx tsx scripts/organize-school-resource-root.ts --apply
 *
 * Apply is idempotent. It changes only folderId; stored file URLs remain valid.
 * After applying, run the RAG reindex so search titles include the new paths.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { resolveFolderPath } from '../lib/school-resources';
import { legacyResourceFolderPath } from '../lib/school-resource-organization';

const apply = process.argv.includes('--apply');
const batchSize = 500;

async function main() {
  const counts = new Map<string, number>();
  const folderIds = new Map<string, string>();
  let lastId = '';
  let total = 0;
  for (;;) {
    const rows = await prisma.schoolResource.findMany({
      where: {
        folderId: null,
        ...(lastId ? { id: { gt: lastId } } : {}),
        NOT: { description: { startsWith: 'From folder upload: ' } },
      },
      orderBy: { id: 'asc' }, take: batchSize,
      select: { id: true, subject: true, category: true, createdAt: true },
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const path = legacyResourceFolderPath(row);
      groups.set(path, [...(groups.get(path) ?? []), row.id]);
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    total += rows.length;
    if (apply) {
      for (const [path, ids] of groups) {
        let folderId = folderIds.get(path);
        if (!folderId) {
          folderId = (await resolveFolderPath(path))!;
          folderIds.set(path, folderId);
        }
        await prisma.schoolResource.updateMany({
          where: { id: { in: ids }, folderId: null }, data: { folderId },
        });
      }
      console.log(`Filed ${total} resources...`);
    }
  }
  console.log(`${apply ? 'Filed' : 'Would file'} ${total} root resources into ${counts.size} folders.`);
  for (const [path, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${count.toString().padStart(6)}  ${path}`);
  }
  if (!apply) console.log('Dry run only. Review the paths, then pass --apply.');
  else console.log('Run npm run rag:index to refresh search paths.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
