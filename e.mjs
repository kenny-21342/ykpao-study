import { readFileSync } from 'node:fs';
import pg from 'pg';
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')]));
const c=new pg.Client({connectionString:env.DIRECT_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
const q=async s=>(await c.query(s)).rows;
console.log('enrolled courses by level:');
console.table(await q(`SELECT co.level, count(*)::int enrollments, count(DISTINCT uc."userId")::int students
  FROM user_courses uc JOIN courses co ON co.id=uc."courseId" GROUP BY co.level ORDER BY enrollments DESC`));
console.log('boundary subjects vs enrolled subject codes:');
console.table(await q(`SELECT DISTINCT cs."subjectCode", cs.board,
  EXISTS(SELECT 1 FROM grade_boundaries gb WHERE gb."subjectCode"=cs."subjectCode") AS has_boundaries
  FROM user_courses uc JOIN course_curriculum_scopes cs ON cs."courseId"=uc."courseId" ORDER BY 2,1`));
await c.end();
