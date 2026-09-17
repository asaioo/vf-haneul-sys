import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Change, Task } from '../shared/types.js';
import { ApiError, requireValue, Store } from './db.js';
import { assertScope, developer, editTask } from './auth.js';
import { coordinate, projectStatus } from './coordinator.js';
export const text=z.string().trim().min(1).max(20_000);
export const version=z.number().int().positive();
export const status=z.enum(['backlog','ready','in_progress','review','done']);
const path=z.string().min(1).max(512).refine(v=>!v.startsWith('/')&&!v.includes('\\')&&!v.includes('\0')&&!v.split('/').some(p=>p==='..'||p==='.'||p==='')&&!/^[A-Za-z]:/.test(v),'Must be repository-relative');
const fields={title:text.max(240),type:z.enum(['feature','bug','chore','docs']),description:z.string().trim().max(20_000),owner:z.string().regex(/^\d+$/).nullable(),criteria:z.array(text.max(2000)).max(100),paths:z.array(path).max(100)};
export const createTaskSchema=z.strictObject({title:fields.title,type:fields.type,description:fields.description.default(''),owner:fields.owner.optional(),criteria:fields.criteria.default([]),paths:fields.paths.default([]),planning_status:z.enum(['backlog','ready']).default('backlog')});
export const patchTaskSchema=z.strictObject({...z.object(fields).partial().shape,expected_version:version,archived:z.boolean().optional()});
export const statusSchema=z.strictObject({expected_version:version,action:z.enum(['set','pause','hold','clear_hold','resume']),status:status.optional(),reason:text,attention_kind:z.enum(['blocked','needs_clarification','needs_human_review']).optional(),confirm_status:status.optional()});
export const linkSchema=z.strictObject({expected_version:version,change_id:z.string().min(1).max(600),expected_change_version:version,previous_task_version:version.optional(),action:z.enum(['confirm','unlink','supersede']).default('confirm'),reason:text});
export const completionSchema=z.strictObject({expected_version:version,change_id:z.string().min(1).max(600).nullable(),expected_change_version:version.optional()});
export const explanationSchema=z.strictObject({expected_change_version:version,revision_sha:z.string().regex(/^[a-f0-9]{40}$/),summary:text,impact:text,validation:z.strictObject({source:z.literal('contributor_report'),result:z.enum(['reported_passed','reported_failed','not_run']),details:z.string().max(20_000)})});
export function taskByKey(s:Store,key:string) {return requireValue(s.all('task').find(t=>t.key===key));}
export function checkVersion(actual:number,expected:number|undefined) {if(actual!==expected)throw new ApiError(409,'Version conflict; refresh before retry');}
function ready(t:Task) {if(t.planning_status==='ready'&&(!t.owner||!t.description||!t.criteria.length))throw new ApiError(422,'Ready requires owner, description, and acceptance criteria');}
function ownerValid(s:Store,t:Task) {if(t.owner&&!s.get('member',t.owner)?.active)throw new ApiError(422,'Owner must be an active member');ready(t);}
function save(s:Store,a:Actor,t:Task,before:unknown,action:string) {t.version++;t.updated_at=Date.now();s.put('task',t.id,t);s.audit(a.agent?`${a.id}/agent:${a.agent}`:a.id,action,t.id,{before,after:t});s.enqueue('projection');coordinate(s);return s.get('task',t.id)!;}
export function createTask(s:Store,a:Actor,input:unknown) {
  assertScope(a,'tasks:write');if(a.role==='viewer')throw new ApiError(403,'Contributor required');
  const b=createTaskSchema.parse(input),p=requireValue(s.get('project','1'));
  const owner=b.owner===undefined?a.id:b.owner;if(a.role!=='developer'&&owner!==a.id&&owner!==null)throw new ApiError(403,'Cannot assign another owner');
  p.sequence++;const now=Date.now();
  const t:Task={...b,id:randomUUID(),key:`${p.prefix}-${p.sequence}`,owner,status:b.planning_status,suggested_status:b.planning_status,sync_mode:'auto',attention_kind:null,attention_reason:null,projection_reason:null,completion_pr_id:null,archived:false,version:1,created_at:now,updated_at:now};
  ownerValid(s,t);s.put('project','1',p);s.put('task',t.id,t);s.audit(a.id,'task.created',t.id,{after:t,agent:a.agent??null});s.enqueue('projection');coordinate(s);return s.get('task',t.id)!;
}
export function patchTask(s:Store,a:Actor,key:string,input:unknown) {
  const b=patchTaskSchema.parse(input),t=taskByKey(s,key);editTask(a,t);checkVersion(t.version,b.expected_version);const before={...t};
  for(const k of Object.keys(fields) as (keyof typeof fields)[])if(b[k]!==undefined)(t as any)[k]=b[k];
  if(a.role!=='developer'&&t.owner!==before.owner)throw new ApiError(403,'Developer required to transfer ownership');
  if(b.archived!==undefined) {
    if(s.all('task_change').some(l=>l.task_id===t.id&&!l.superseded_reason&&s.get('git_change',l.change_id)?.state!=='merged'))throw new ApiError(409,'Resolve active linked work before archiving');
    t.archived=b.archived;
  }
  ownerValid(s,t);return save(s,a,t,before,'task.updated');
}
export function taskStatus(s:Store,a:Actor,key:string,input:unknown) {
  const b=statusSchema.parse(input),t=taskByKey(s,key);editTask(a,t);checkVersion(t.version,b.expected_version);const before={...t};
  const pairs=s.all('task_change').filter(l=>l.task_id===t.id).map(link=>({link,change:requireValue(s.get('git_change',link.change_id))})).filter(x=>!x.change.canonical_id);
  if(b.action==='set') {
    if(!b.status)throw new ApiError(422,'status required');
    if(b.status==='done'||t.status==='done')developer(a);
    if((b.status==='backlog'||b.status==='ready')&&!pairs.length){t.planning_status=b.status;t.status=b.status;ready(t);}else {t.status=b.status;t.sync_mode='manual';}
  } else if(b.action==='pause')t.sync_mode='manual';
  else if(b.action==='hold'){if(!b.attention_kind)throw new ApiError(422,'attention_kind required');t.attention_kind=b.attention_kind;t.attention_reason=b.reason;t.sync_mode='manual';}
  else if(b.action==='clear_hold'){t.attention_kind=null;t.attention_reason=null;t.sync_mode='manual';}
  else {
    if(t.attention_kind)throw new ApiError(409,'Clear hold before resuming');
    const suggestion=projectStatus(t,pairs,requireValue(s.get('project','1')));
    if(suggestion.reason)throw new ApiError(409,suggestion.reason);
    if(b.confirm_status!==suggestion.status)throw new ApiError(409,'Confirm the current suggested status');
    if(t.status==='done'&&suggestion.status!=='done')developer(a);
    t.sync_mode='auto';t.status=suggestion.status;
  }
  return save(s,a,t,before,`task.status.${b.action}`);
}
function linkAuthority(a:Actor,t:Task) {assertScope(a,'links:write');if(a.role==='viewer'||a.role!=='developer'&&a.id!==t.owner)throw new ApiError(403,'Association requires task ownership');}
export function linkTask(s:Store,a:Actor,key:string,input:unknown) {
  const b=linkSchema.parse(input),t=taskByKey(s,key);linkAuthority(a,t);checkVersion(t.version,b.expected_version);
  const c=requireValue(s.get('git_change',b.change_id));checkVersion(c.version,b.expected_change_version);if(c.canonical_id)throw new ApiError(409,`Use canonical change ${c.canonical_id}`);
  const old=s.get('task_change',c.id),before={...t};
  if(old&&old.task_id!==t.id) {const previous=requireValue(s.get('task',old.task_id));linkAuthority(a,previous);checkVersion(previous.version,b.previous_task_version);if(previous.status==='done')developer(a);if(previous.completion_pr_id===c.id)previous.completion_pr_id=null;previous.version++;s.put('task',previous.id,previous);s.audit(a.id,'association.displaced',previous.id,{change:c.id,reason:b.reason});}
  if(b.action==='unlink'||b.action==='supersede') {
    if(!old||old.task_id!==t.id)throw new ApiError(409,'Change is not linked to this task');
    if(b.action==='supersede'){developer(a);if(c.kind!=='pr'||c.state==='open')throw new ApiError(422,'Only closed/replaced PRs can be superseded');old.superseded_reason=b.reason;s.put('task_change',c.id,old);}
    else {if(t.status==='done')developer(a);s.db.prepare('DELETE FROM task_change WHERE id=?').run(c.id);s.db.prepare('INSERT OR REPLACE INTO association_rejection VALUES(?,?,?,?)').run(c.id,c.head_sha,a.id,b.reason);}
    if(t.completion_pr_id===c.id)t.completion_pr_id=null;
  } else {
    if(t.archived||t.status==='done'&&(!old||old.task_id!==t.id))throw new ApiError(409,'Explicitly reopen task before linking new work');
    if(!c.complete)throw new ApiError(409,'Current Git evidence unavailable');
    if(c.integrity){developer(a);c.integrity=null;c.version++;s.put('git_change',c.id,c);}
    s.put('task_change',c.id,{change_id:c.id,task_id:t.id,state:'confirmed',source:'manual',actor:a.agent?`${a.id}/agent:${a.agent}`:a.id,evidence:[b.reason],revision:c.head_sha,superseded_reason:null});
  }
  s.audit(a.id,`association.${b.action}`,t.id,{change:c.id,old,reason:b.reason,agent:a.agent??null});
  return save(s,a,t,before,'task.links');
}
export function completion(s:Store,a:Actor,key:string,input:unknown) {
  const b=completionSchema.parse(input),t=taskByKey(s,key);linkAuthority(a,t);checkVersion(t.version,b.expected_version);const before={...t};
  if(b.change_id) {const c=requireValue(s.get('git_change',b.change_id)),l=s.get('task_change',c.id);checkVersion(c.version,b.expected_change_version);if(c.kind!=='pr'||!l||l.task_id!==t.id||l.state!=='confirmed'||l.superseded_reason||c.canonical_id)throw new ApiError(422,'Completion requires a confirmed required PR');}
  if(t.status==='done'&&t.completion_pr_id!==b.change_id)developer(a);
  t.completion_pr_id=b.change_id;return save(s,a,t,before,'task.completion');
}
export function explain(s:Store,a:Actor,id:string,input:unknown) {
  assertScope(a,'explanations:write');const b=explanationSchema.parse(input),c=requireValue(s.get('git_change',id));checkVersion(c.version,b.expected_change_version);
  const l=s.get('task_change',id),t=l?s.get('task',l.task_id):undefined;
  if(a.role==='viewer'||a.role!=='developer'&&c.actor!==a.id&&t?.owner!==a.id)throw new ApiError(403,'Change contributor or task owner required');
  if(c.canonical_id||c.head_sha!==b.revision_sha)throw new ApiError(409,'Submit at the current canonical head revision');
  const {expected_change_version,...payload}=b;
  const e={...payload,id:randomUUID(),change_id:id,author:a.id,agent:a.agent??null,created_at:Date.now()};s.put('explanation',e.id,e);s.audit(a.id,'explanation.created',id,{explanation:e.id,revision:e.revision_sha,agent:e.agent});coordinate(s);return e;
}
export function changeDetail(s:Store,c:Change) {return {...c,association:s.get('task_change',c.id)??null,explanations:s.all('explanation').filter(e=>e.change_id===c.id).map(e=>({...e,stale:e.revision_sha!==c.head_sha})),history:s.db.prepare('SELECT data,at FROM change_history WHERE change_id=? ORDER BY id DESC LIMIT 100').all(c.id).map((r:any)=>({change:JSON.parse(r.data),at:r.at})),actions:s.all('action_item').filter(a=>a.subject===c.id)};}
export function taskDetail(s:Store,t:Task) {return {...t,changes:s.all('task_change').filter(l=>l.task_id===t.id).map(l=>s.get('git_change',l.change_id)).filter((c):c is Change=>!!c&&!c.canonical_id).map(c=>changeDetail(s,c)),actions:s.all('action_item').filter(a=>a.subject===t.id),timeline:s.db.prepare('SELECT * FROM audit_entry WHERE entity=? ORDER BY id DESC LIMIT 100').all(t.id).map((r:any)=>({...r,data:JSON.parse(r.data)}))};}
