import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')]));
const c=new pg.Client({connectionString:env.DIRECT_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
const EMAIL='linhongsheng07@gmail.com';
const before=(await c.query('SELECT id,email,"tourCompletedAt" FROM users WHERE email=$1',[EMAIL])).rows;
if(!before.length){ console.log('no such user'); await c.end(); process.exit(1); }
const path=`backups/tour-flag-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(path, JSON.stringify(before,null,2));
console.log('backup written:', path);
console.log('before:', before);
const r=await c.query('UPDATE users SET "tourCompletedAt"=NULL WHERE email=$1',[EMAIL]);
console.log('rows updated:', r.rowCount);
console.log('after:', (await c.query('SELECT email,"tourCompletedAt" FROM users WHERE email=$1',[EMAIL])).rows);
await c.end();
