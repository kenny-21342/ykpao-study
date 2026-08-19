// E2E probe: seed the test user and find a past paper whose PDF is already in R2.
// Run with: node --experimental-strip-types .e2e-probe.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })) });

const mode = process.argv[2] ?? 'seed';

if (mode === 'seed') {
  const email = 'e2e.tester@e2e.invalid';
  const password = await bcrypt.hash('E2eTester!2026', 12);
  const u = await prisma.user.upsert({ where: { email }, update: { password }, create: { email, password, name: 'E2E Tester' } });
  console.log('USER', u.id, u.email);
}

if (mode === 'find-r2-paper') {
  const { S3ObjectStore } = await import('./lib/storage/s3-store.ts');
  const { paperKey } = await import('./lib/storage/keys.ts');
  const store = new S3ObjectStore({
    bucket: process.env.STORAGE_BUCKET,
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    region: 'auto',
    endpoint: process.env.STORAGE_ENDPOINT,
    signedUrlTtlSeconds: 900,
  });
  const where = process.argv[3] ? { filepath: { contains: process.argv[3] } } : {};
  const papers = await prisma.pastPaper.findMany({ where, select: { id: true, filename: true, filepath: true }, take: 400, orderBy: { id: 'asc' } });
  let hits = 0;
  for (const p of papers) {
    const key = paperKey(p.filepath);
    if (!key) continue;
    const meta = await store.head(key).catch((e) => { console.log('HEAD-ERR', key, String(e).slice(0, 120)); return null; });
    if (meta) {
      console.log('PRESENT', p.id, meta.size, key);
      if (++hits >= 5) break;
    }
  }
  if (!hits) console.log('NONE-PRESENT of', papers.length, 'checked');
}

await prisma.$disconnect();
