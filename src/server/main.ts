import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { Store } from './db.js';
import { GitHubProvider } from './github.js';
import { FakeProvider, seedDemo, demoSha } from './demo.js';
import { buildApp } from './app.js';
import { admin } from './auth.js';
const cfg=config();process.umask(0o077);mkdirSync(dirname(cfg.dbPath),{recursive:true,mode:0o700});
const store=new Store(cfg.dbPath);chmodSync(cfg.dbPath,0o600);
const existing=store.get('project','1');if(existing&&(existing.repo_id!==cfg.repoId||existing.installation_id!==cfg.installationId))throw new Error('Database identity does not match configured repository/installation');
if(existing?.confirmed&&existing.source_of_truth==='github'&&!cfg.demo&&existing.project_node_id!==cfg.projectNodeId)throw new Error('Database confirmed Projects v2 node does not match configured project node; refuse authority drift');
if(existing&&existing.source_of_truth!=='github'&&!cfg.demo)throw new Error('Legacy local-PM database detected. Back it up and configure a new GitHub-native database; no bulk reinterpretation is performed.');
const provider=cfg.demo?new FakeProvider():new GitHubProvider(cfg);
if(provider instanceof FakeProvider) {seedDemo(store,cfg,provider);provider.data.changes=store.all('git_change').filter(c=>c.kind==='pr');}
const {app}=await buildApp(cfg,store,provider);
if(cfg.demo&&provider instanceof FakeProvider)app.post('/api/demo/advance',async req=>{
  admin(req.actor);const b=z.strictObject({change_id:z.string(),state:z.enum(['draft','review','merged','closed','push'])}).parse(req.body);
  const c=provider.data.changes.find(c=>c.id===b.change_id);if(!c)return {error:'Unknown FAKE demo change'};
  if(b.state==='push'){c.head_sha=demoSha(Date.now());c.commits.push({sha:c.head_sha,message:'FAKE new demo commit',actor:'1',url:'https://example.invalid/FAKE/commit'});c.state='open';}
  else {c.state=b.state==='draft'||b.state==='review'?'open':b.state;c.draft=b.state==='draft';if(b.state==='merged')c.merge_sha=demoSha(Date.now());}
  store.enqueue('reconcile');return {demo:true,queued:true};
});
await app.listen({host:cfg.host,port:cfg.port});
console.info(`vf-kapo ${cfg.demo?'FAKE DATA / ISOLATED DEMO':'GitHub App'} listening at ${cfg.origin}`);
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void app.close().then(()=>{store.close();process.exit(0);});});
