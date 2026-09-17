import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Auth, admin, assertScope, equal, hash, secret } from './auth.js';
import type { Config } from './config.js';
import { ApiError, requireValue, Store } from './db.js';
import { coordinate, issueReferences } from './coordinator.js';
import type { Provider } from './github.js';
import { edgeReviewTrigger, GovernanceService, governanceTrigger, GOVERNANCE_JOB } from './governance.js';
import { OpenAIModelClient, type GovernanceModelClient } from './model.js';
import { changeDetail, completion, createTask, explain, linkTask, patchTask, taskByKey, taskDetail, taskStatus, text } from './tasks.js';
import { Worker } from './worker.js';
const params=(r:FastifyRequest)=>r.params as Record<string,string>;
const pageSchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(100_000).default(0)});
function paginate<T>(rows:T[],query:unknown) {const p=pageSchema.parse(query);return {items:rows.slice(p.offset,p.offset+p.limit),total:rows.length,limit:p.limit,offset:p.offset,next_offset:p.offset+p.limit<rows.length?p.offset+p.limit:null};}
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
const nativeMessage='GitHub Issues and the configured GitHub Project own task content and status; use GitHub or gh/API. vf-kapo only reads observations and coordinates warnings.';
function isNative(s:Store,cfg:Config) { const project=s.get('project','1'); return !!cfg.projectNodeId || project?.source_of_truth==='github' || !!project?.project_node_id; }
export async function buildApp(cfg:Config,s:Store,provider:Provider,options:{worker?:boolean;staticRoot?:string;model?:GovernanceModelClient}={}) {
  if(provider.fake&&!cfg.demo)throw new Error('Fake provider is forbidden outside explicit demo/testing configuration');
  if(cfg.demo&&(cfg.production||cfg.host!=='127.0.0.1'))throw new Error('Unsafe demo configuration');
  const app=Fastify({bodyLimit:1024*1024,logger:false,trustProxy:false,routerOptions:{maxParamLength:700}});
  await app.register(cookie);await app.register(rateLimit,{max:240,timeWindow:'1 minute'});
  const auth=new Auth(s,cfg,provider),governance=new GovernanceService(s,provider,cfg,options.model??new OpenAIModelClient({enabled:cfg.governanceEnabled??false,apiKey:cfg.governanceModelApiKey??'',baseUrl:cfg.governanceModelBaseUrl,model:cfg.governanceModel??'',privateCodeOptIn:cfg.governancePrivateCodeOptIn??false,disableThinking:cfg.governanceModelDisableThinking})),worker=new Worker(s,provider,governance);
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(cfg.demo&&req.headers.host&&!['127.0.0.1','localhost','[::1]'].includes(req.headers.host.replace(/:\d+$/,'')))throw new ApiError(403,'Demo requires loopback Host');
    if(req.routeOptions.url?.startsWith('/api/'))await auth.authenticate(req);
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof z.ZodError)return reply.code(422).send({error:'Validation failed',issues:error.issues.map(i=>({path:i.path,message:i.message}))});
    const e=error as Error&{statusCode?:number};const code=e.statusCode??500;
    return reply.code(code).send({error:code>=500?'Service unavailable; see synchronization health':e.message});
  });
  auth.routes(app);
  app.get('/auth/config',async()=>({demo:cfg.demo,login_url:cfg.demo?null:'/auth/github'}));
  app.get('/api/me',async req=>({member:publicMember(requireValue(s.get('member',req.actor.id))),agent:req.actor.agent??null,scopes:req.actor.scopes,csrf_token:req.csrfToken??null,demo:cfg.demo}));
  app.get('/api/governance',async req=>{const q=z.object({state:z.enum(['queued','running','diagnostic','not_configured','result','proposal']).optional()}).parse(req.query);return paginate(s.all('governance_request').filter(value=>!q.state||value.state===q.state).sort((a,b)=>b.updated_at-a.updated_at).map(publicGovernance),req.query);});
  app.get('/api/governance/requests',async req=>{const q=z.object({state:z.enum(['queued','running','diagnostic','not_configured','result','proposal']).optional()}).parse(req.query);return paginate(s.all('governance_request').filter(value=>!q.state||value.state===q.state).sort((a,b)=>b.updated_at-a.updated_at).map(publicGovernance),req.query);});
  app.get('/api/governance/:id',async req=>publicGovernance(requireValue(s.get('governance_request',params(req).id))));
  app.get('/api/governance/requests/:id',async req=>publicGovernance(requireValue(s.get('governance_request',params(req).id))));
  // All retryable domain effects, idempotency result, audit, and queue writes share one transaction.
  const mutate=(req:FastifyRequest,fn:()=>unknown)=>s.tx(()=>{
    const current=s.get('member',req.actor.id);if(!current?.active||current.role!==req.actor.role)throw new ApiError(403,'Membership changed; authenticate again');
    const key=req.headers['idempotency-key'];if(key!==undefined&&(typeof key!=='string'||key.length>200||!key.length))throw new ApiError(422,'Invalid Idempotency-Key');
    const route=`${req.actor.id}:${req.actor.agent??'human'}:${req.actor.scopes.slice().sort().join(',')}:${req.method}:${req.url.split('?')[0]}:${key}`;
    const digest=hash(canonical(req.body??{}));
    if(key) {const old=s.db.prepare('SELECT * FROM idempotency WHERE key=? AND expires>?').get(route,Date.now()) as any;if(old){if(old.digest!==digest)throw new ApiError(409,'Idempotency key reused with different content');return JSON.parse(old.result);}}
    const value=fn();if(key)s.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,result=excluded.result,expires=excluded.expires').run(route,digest,JSON.stringify(value),Date.now()+7*86400_000);return value;
  });
  const nativeMode=()=>isNative(s,cfg);
  const rejectLegacyWrite=()=>{throw new ApiError(410,nativeMessage);};
  app.get('/api/issues',async req=>{
    const q=z.object({query:z.string().max(240).optional(),state:z.enum(['open','closed','all']).default('all')}).parse(req.query);
    const p=s.get('project','1');
    const projectNodeId = cfg.projectNodeId || p?.project_node_id;
    const items=s.all('project_item');
    const issues=s.all('github_issue').filter(issue=>issue.repo_id===p?.repo_id&&(q.state==='all'||issue.state===q.state)&&(!q.query||`${issue.number} ${issue.title} ${issue.body}`.toLowerCase().includes(q.query.toLowerCase()))).sort((a,b)=>b.updated_at-a.updated_at).map(issue=>({...issue,project_item:items.find(item=>item.content_type==='Issue'&&item.project_node_id===projectNodeId&&item.issue_number===issue.number&&item.repo_id===issue.repo_id)??null}));
    return paginate(issues,req.query);
  });
  app.get('/api/issues/:number',async req=>{
    const number=z.coerce.number().int().positive().parse(params(req).number),p=requireValue(s.get('project','1'));
    const projectNodeId = cfg.projectNodeId || p.project_node_id;
    const issue=requireValue(s.all('github_issue').find(value=>value.repo_id===p.repo_id&&value.number===number));
    const item=s.all('project_item').find(value=>value.content_type==='Issue'&&value.project_node_id===projectNodeId&&value.repo_id===p.repo_id&&value.issue_number===number)??null;
    const changes=s.all('git_change').filter(change=>issueReferences(change,p.full_name).numbers.includes(number)&&!change.canonical_id);
    return {...issue,project_item:item,changes,warning:item?'':`Issue #${number} is not a member of the configured Project`};
  });
  app.get('/api/tasks',async req=>{
    const q=z.object({query:z.string().max(240).optional(),owner:z.string().optional(),attention:z.enum(['true','false']).optional(),archived:z.enum(['true','false']).optional()}).parse(req.query);
    return paginate(s.all('task').filter(t=>(q.archived==='true'?t.archived:!t.archived)&&(!q.owner||t.owner===q.owner)&&(!q.query||`${t.key} ${t.title}`.toLowerCase().includes(q.query.toLowerCase()))&&(!q.attention||q.attention==='true'===(!!t.attention_kind||!!t.projection_reason||s.all('action_item').some(a=>a.subject===t.id&&a.state==='open')))).sort((a,b)=>a.created_at-b.created_at),req.query);
  });
  app.get('/api/tasks/:key',async req=>taskDetail(s,taskByKey(s,params(req).key)));
  app.post('/api/tasks',async req=>nativeMode()?rejectLegacyWrite():mutate(req,()=>createTask(s,req.actor,req.body)));
  app.patch('/api/tasks/:key',async req=>nativeMode()?rejectLegacyWrite():mutate(req,()=>patchTask(s,req.actor,params(req).key,req.body)));
  app.post('/api/tasks/:key/status',async req=>nativeMode()?rejectLegacyWrite():mutate(req,()=>taskStatus(s,req.actor,params(req).key,req.body)));
  app.post('/api/tasks/:key/links',async req=>nativeMode()?rejectLegacyWrite():mutate(req,()=>linkTask(s,req.actor,params(req).key,req.body)));
  app.post('/api/tasks/:key/completion',async req=>nativeMode()?rejectLegacyWrite():mutate(req,()=>completion(s,req.actor,params(req).key,req.body)));
  app.get('/api/changes',async req=>paginate(s.all('git_change').filter(c=>!c.canonical_id),req.query));
  app.get('/api/changes/:id',async req=>changeDetail(s,requireValue(s.get('git_change',params(req).id))));
  app.post('/api/changes/:id/explanations',async req=>mutate(req,()=>explain(s,req.actor,params(req).id,req.body)));
  app.get('/api/inbox',async req=>{const q=z.object({recipient:z.string().optional(),state:z.enum(['open','resolved','dismissed','all']).default('open')}).parse(req.query);if(q.recipient&&req.actor.role!=='developer'&&q.recipient!==req.actor.id)throw new ApiError(403,'Inbox recipient access denied');const visible=s.all('action_item').filter(a=>req.actor.role==='developer'||a.recipient===null||a.recipient===req.actor.id);return paginate(visible.filter(a=>(!q.recipient||a.recipient===q.recipient)&&(q.state==='all'||a.state===q.state)).sort((a,b)=>b.updated_at-a.updated_at),req.query);});
  app.post('/api/inbox/:id/resolve',async req=>mutate(req,()=>{
    assertScope(req.actor,'links:write');const b=z.strictObject({action:z.enum(['resolve','dismiss','reassign']),reason:text,revision:z.string().max(600),recipient:z.string().nullable().optional()}).parse(req.body);
    const a=requireValue(s.get('action_item',params(req).id));if(a.revision!==b.revision)throw new ApiError(409,'Inbox revision changed');
    if(req.actor.role==='viewer'||req.actor.role!=='developer'&&a.recipient!==req.actor.id)throw new ApiError(403,'Assigned recipient required');
    if(nativeMode()&&b.action==='resolve')throw new ApiError(409,`${nativeMessage} Resolve the underlying warning in GitHub, then wait for reconciliation.`);
    if(b.action==='reassign'){admin(req.actor);if(b.recipient&&!s.get('member',b.recipient)?.active)throw new ApiError(422,'Active recipient required');a.recipient=b.recipient??null;}
    else if(b.action==='dismiss'){admin(req.actor);if(a.kind!=='untracked_change')throw new ApiError(409,'Only intentional untracked exceptions can be dismissed');a.state='dismissed';a.resolution_reason=b.reason;}
    else {coordinate(s);const current=requireValue(s.get('action_item',a.id));if(current.state!=='resolved')throw new ApiError(409,'Resolve the underlying condition first (link, explain, or recover sync)');return current;}
    a.updated_at=Date.now();s.put('action_item',a.id,a);s.audit(req.actor.id,`inbox.${b.action}`,a.subject,{item:a.id,reason:b.reason});return a;
  }));
  app.get('/api/project/context',async req=>{
    const p=requireValue(s.get('project','1')),q=z.object({task:z.string().optional(),issue:z.coerce.number().int().positive().optional(),change:z.string().optional(),sha:z.string().regex(/^[a-f0-9]{40}$/).optional()}).parse(req.query);
    const snapshot=q.sha?s.get('context_snapshot',q.sha):p.checkpoint?s.get('context_snapshot',p.checkpoint):undefined;
    const issue=q.issue?s.all('github_issue').find(value=>value.repo_id===p.repo_id&&value.number===q.issue)??null:null;
    return {project:p,snapshot:snapshot??null,pending:!snapshot,stale:!!p.error||Date.now()-p.last_sync>600_000,issue,task:q.task&&!isNative(s,cfg)?taskDetail(s,taskByKey(s,q.task)):null,change:q.change?changeDetail(s,requireValue(s.get('git_change',q.change))):null,governance:s.all('governance_request').sort((a,b)=>b.updated_at-a.updated_at).slice(0,100).map(publicGovernance),warning:'Read root and applicable directory policies from your actual checkout; this is not the complete execution contract.'};
  });
  app.get('/api/project',async()=>{const project=s.get('project','1');return {project:project??null,issues:s.all('github_issue').filter(issue=>issue.repo_id===project?.repo_id).length,project_items:s.all('project_item').filter(item=>item.repo_id===project?.repo_id&&item.project_node_id===(cfg.projectNodeId||project?.project_node_id)).length,demo:cfg.demo};});
  app.get('/api/project/onboarding',async req=>{admin(req.actor);return {configured_repository_id:cfg.repoId,configured_installation_id:cfg.installationId,configured_project_node_id:cfg.projectNodeId||null,project:s.get('project','1')??null,repository:await provider.repository()};});
  app.post('/api/project/onboarding',async req=>{
    admin(req.actor);const b=z.strictObject({repository_id:z.string(),installation_id:z.string(),confirm:z.literal(true)}).parse(req.body);
    if(b.repository_id!==cfg.repoId||b.installation_id!==cfg.installationId)throw new ApiError(422,'Confirm exactly the configured immutable identities');
    if(!cfg.projectNodeId)throw new ApiError(422,'Configure GITHUB_PROJECT_NODE_ID before onboarding');
    const repo=await provider.repository();
    return mutate(req,()=>{const old=s.get('project','1');if(old&&old.source_of_truth!=='github')throw new ApiError(409,'This database contains legacy local-PM data. Back it up and use a new GitHub-native database; no bulk reinterpretation is performed.');if(old?.confirmed){if(old.project_node_id!==cfg.projectNodeId)throw new ApiError(409,'Configured Projects v2 node does not match the confirmed project; refuse authority drift.');return old;}
      const p={repo_id:repo.id,installation_id:repo.installation_id,full_name:repo.full_name,url:repo.url,integration_branch:repo.default_branch,default_branch:repo.default_branch,prefix:cfg.prefix,sequence:old?.sequence??0,confirmed:true,init:'pending' as const,last_sync:0,checkpoint:repo.head_sha,error:null,coverage_start:Date.now(),gaps:[],source_of_truth:'github' as const,project_node_id:cfg.projectNodeId,project_status_field_id:null,project_status_field_name:null,project_url:null,legacy_data_warning:null};
      s.put('project','1',p);s.enqueue('reconcile');s.audit(req.actor.id,'project.github_confirmed','project',p);return p;});
  });
  app.post('/api/project/config',async req=>{
    admin(req.actor);const b=z.strictObject({integration_branch:text.max(240),confirm:z.literal(true),reason:text,expected_branch:z.string()}).parse(req.body);const repo=await provider.repository();
    if(b.integration_branch!==repo.default_branch)throw new ApiError(422,'Integration target must be the current default branch');
    return mutate(req,()=>{const p=requireValue(s.get('project','1'));if(p.integration_branch!==b.expected_branch)throw new ApiError(409,'Configuration changed');p.integration_branch=b.integration_branch;p.init='pending';p.checkpoint=null;p.gaps.push('Integration branch explicitly reconfigured; a new monitoring baseline is required');s.put('project','1',p);s.enqueue('reconcile');s.audit(req.actor.id,'project.integration_branch','project',b);return p;});
  });
  app.get('/api/health/sync',async()=>{const p=s.get('project','1'),jobs=s.all('event_job'),reviews=s.all('governance_request');return {project:p??null,demo:cfg.demo,native:isNative(s,cfg),stale:!p?.last_sync||Date.now()-p.last_sync>600_000,degraded:!!p?.error||s.all('git_change').some(c=>!c.complete),pending:jobs.filter(j=>j.state==='queued'||j.state==='running').length,failed:jobs.filter(j=>j.state==='failed').length,jobs:jobs.filter(j=>j.state!=='done').slice(-100).map(({payload,...j})=>j),governance:{enabled:!!cfg.governanceEnabled,model_configured:!!cfg.governanceEnabled&&!!cfg.governanceModelApiKey&&!!cfg.governanceModel&&!!cfg.governancePrivateCodeOptIn,pending:reviews.filter(r=>r.state==='queued'||r.state==='running').length,proposals:reviews.filter(r=>r.state==='proposal').length},rate_limit:'rateLimit' in provider?provider.rateLimit:null};});
  app.post('/api/project/resync',async req=>{admin(req.actor);return mutate(req,()=>{z.strictObject({retry_failed:z.boolean().default(false)}).parse(req.body??{});for(const j of s.all('event_job').filter(j=>j.state==='failed')){j.state='queued';j.attempts=0;j.next_at=Date.now();s.put('event_job',j.id,j);}const existing=s.all('event_job').find(j=>j.type==='reconcile'&&(j.state==='queued'||j.state==='running'));return {job_id:existing?.id??s.enqueue('reconcile')};});});
  app.get('/api/members',async req=>paginate(s.all('member').map(publicMember),req.query));
  app.post('/api/members',async req=>{admin(req.actor);return mutate(req,()=>{const b=z.strictObject({id:z.string().regex(/^\d+$/),login:text.max(100),role:z.enum(['viewer','contributor','developer']),active:z.boolean().default(true)}).parse(req.body);if(b.id===req.actor.id&&(!b.active||b.role!=='developer'))throw new ApiError(409,'Cannot revoke/demote your current admin session');const old=s.get('member',b.id);const m={...old,...b,access_checked:0};s.put('member',m.id,m);if(!m.active){s.db.prepare('DELETE FROM session WHERE member_id=?').run(m.id);s.db.prepare('UPDATE agent_token SET revoked=? WHERE member_id=?').run(Date.now(),m.id);}s.audit(req.actor.id,'member.updated',m.id,{role:m.role,active:m.active});coordinate(s);return publicMember(m);});});
  app.get('/api/tokens',async req=>{if(req.actor.agent)throw new ApiError(403,'Agents cannot manage credentials');return paginate(s.db.prepare('SELECT hash as id,label,scopes,expires,revoked FROM agent_token WHERE member_id=?').all(req.actor.id).map((r:any)=>({...r,scopes:JSON.parse(r.scopes)})),req.query);});
  app.post('/api/tokens',async req=>{if(req.actor.agent)throw new ApiError(403,'Agents cannot create credentials');const b=z.strictObject({label:text.max(100),scopes:z.array(z.enum(['read','tasks:write','links:write','explanations:write'])).min(1).max(4),expires_days:z.number().int().min(1).max(30)}).parse(req.body);if(!b.scopes.includes('read'))throw new ApiError(422,'read scope required');return s.tx(()=>{const token=secret(),id=hash(token);s.db.prepare('INSERT INTO agent_token VALUES(?,?,?,?,?,NULL)').run(id,req.actor.id,b.label,JSON.stringify(b.scopes),Date.now()+b.expires_days*86400_000);s.audit(req.actor.id,'token.created',id,{label:b.label,scopes:b.scopes});return {id,token,expires:Date.now()+b.expires_days*86400_000};});});
  app.delete('/api/tokens/:id',async req=>{if(req.actor.agent)throw new ApiError(403,'Agents cannot manage credentials');return mutate(req,()=>{s.db.prepare('UPDATE agent_token SET revoked=? WHERE hash=? AND member_id=?').run(Date.now(),params(req).id,req.actor.id);s.audit(req.actor.id,'token.revoked',params(req).id,{});return {ok:true};});});
  app.get('/api/audit',async req=>{const q=z.object({entity:z.string().max(700).optional()}).parse(req.query);const rows=q.entity?s.db.prepare('SELECT * FROM audit_entry WHERE entity=? ORDER BY id DESC').all(q.entity):s.db.prepare('SELECT * FROM audit_entry ORDER BY id DESC').all();return paginate(rows.map((r:any)=>({...r,data:JSON.parse(r.data)})),req.query);});
  app.get('/api/metrics',async()=>{
    const commits=s.db.prepare('SELECT sha FROM git_commit').all() as {sha:string}[];
    const links=s.all('task_change').filter(l=>l.state==='confirmed');const covered=new Set<string>();for(const l of links)for(const c of (s.db.prepare('SELECT sha FROM membership WHERE change_id=?').all(l.change_id) as {sha:string}[]))covered.add(c.sha);
    const merged=s.all('git_change').filter(c=>c.kind==='pr'&&c.state==='merged');const untracked=merged.filter(c=>!links.some(l=>l.change_id===c.id)).length;
    return {commit_traceability:{numerator:covered.size,denominator:commits.length,ratio:commits.length?covered.size/commits.length:null},untracked_merges:{numerator:untracked,denominator:merged.length,ratio:merged.length?untracked/merged.length:null},direct_commits:s.all('git_change').filter(c=>c.kind==='direct_commit').length,unresolved:s.all('action_item').filter(a=>a.state==='open').length,coverage_start:s.get('project','1')?.coverage_start??null,gaps:s.get('project','1')?.gaps??[],note:'Observed pilot window only; state accuracy requires manual audit. Dismissed untracked work remains unlinked.'};
  });
  await app.register(async webhook=>{
    webhook.removeContentTypeParser('application/json');webhook.addContentTypeParser('application/json',{parseAs:'buffer'},(req,body,done)=>done(null,body));
    webhook.post('/webhooks/github',{bodyLimit:1024*1024,config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
      const raw=req.body as Buffer;if(!Buffer.isBuffer(raw))throw new ApiError(415,'JSON webhook required');
      const signature=String(req.headers['x-hub-signature-256']??'');const expected='sha256='+createHmac('sha256',cfg.webhookSecret).update(raw).digest('hex');if(!equal(signature,expected))throw new ApiError(401,'Invalid webhook signature');
      const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+$/).parse(req.headers['x-github-delivery']);
      const event=z.enum(['push','create','delete','pull_request','issue_comment','issues','installation','installation_repositories','repository','ping']).parse(req.headers['x-github-event']);
      let payload:any;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new ApiError(422,'Invalid JSON');}
      if(String(payload.installation?.id)!==cfg.installationId||payload.repository&&String(payload.repository.id)!==cfg.repoId)throw new ApiError(403,'Webhook identity does not match configured installation/repository');
      if(!payload.repository&&!['installation','installation_repositories','ping'].includes(event))throw new ApiError(422,'Repository identity required');
      const trigger=governanceTrigger(payload,cfg,id)??edgeReviewTrigger(event,payload,cfg,id);
      const ownGovernanceBotEvent=event==='issues'&&payload.action==='labeled'&&payload.label?.name==='kapo:review-agents'&&payload.sender?.type==='Bot';
      const result=s.tx(()=>{
        const key=`github:${id}`;if(s.get('event_job',key))return {accepted:true,duplicate:true};
        const p=s.get('project','1');
        if(p&&(event==='installation'&&['deleted','suspend'].includes(payload.action)||event==='installation_repositories'&&payload.repositories_removed?.some((r:any)=>String(r.id)===cfg.repoId))){p.error='GitHub installation access removed or suspended';s.put('project','1',p);s.notice('sync_error','project',id,p.error);}
        // Deletion is lifecycle evidence, not a user-authored Git fact. A subsequent fetch establishes new incarnation.
        if(event==='delete'&&payload.ref_type==='branch')for(const c of s.all('git_change').filter(c=>c.kind==='branch'&&c.branch===payload.ref&&!c.canonical_id&&c.state!=='deleted')){c.state='deleted';c.integrity='Branch deletion observed; history retained';c.version++;s.put('git_change',c.id,c);}
        if(ownGovernanceBotEvent)return {accepted:true,ignored:true};
        if(trigger){
          if(!s.get('governance_request',trigger.request.id)){s.put('governance_request',trigger.request.id,trigger.request);s.audit(trigger.request.requester_id,'governance.requested',trigger.request.id,{issue_number:trigger.request.issue_number,pr_number:trigger.request.pr_number,issue_body_hash:trigger.request.issue_body_hash});}
          s.enqueue(GOVERNANCE_JOB,{request_id:trigger.request.id},key);
          return {accepted:true,duplicate:false,governance:true,request_id:trigger.request.id};
        }
        s.enqueue(event,payload,key);return {accepted:true,duplicate:false};
      });return reply.code(202).send(result);
    });
  });
  const staticRoot=options.staticRoot??resolve('dist/client');if(existsSync(staticRoot)) {await app.register(staticFiles,{root:staticRoot});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')||req.url.startsWith('/auth/')?reply.code(404).send({error:'Not found'}):reply.sendFile('index.html'));}
  else app.get('/',async(req,reply)=>reply.type('text/plain').send('vf-kapo API is running. Build the React client for the browser UI.'));
  if(options.worker!==false)worker.start();app.addHook('onClose',async()=>worker.stop());
  return {app,auth,worker};
}
function publicMember(m:{id:string;login:string;role:string;active:boolean}) {return {id:m.id,login:m.login,role:m.role,active:m.active};}

function publicGovernance(request: import('../shared/types.js').GovernanceRequest) { return { ...request }; }
