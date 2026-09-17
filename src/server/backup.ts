import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const [source,target]=process.argv.slice(2);
if(!source||!target)throw new Error('Usage: npm run backup -- /absolute/live.sqlite /absolute/backup.sqlite');
if(resolve(source)===resolve(target)||existsSync(target))throw new Error('Backup destination must be new and different from source');
process.umask(0o077);mkdirSync(dirname(resolve(target)),{recursive:true,mode:0o700});
const db=new DatabaseSync(resolve(source),{readOnly:true});
try {await backup(db,resolve(target));chmodSync(target,0o600);const copy=new DatabaseSync(resolve(target),{readOnly:true});try {const result=copy.prepare('PRAGMA integrity_check').get() as {integrity_check:string};if(result.integrity_check!=='ok')throw new Error('Backup integrity check failed');}finally{copy.close();}console.info('SQLite-consistent backup and integrity check completed. Store encrypted off-host.');}finally{db.close();}
