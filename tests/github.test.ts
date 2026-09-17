import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { applicableScopedPolicies, GitHubProvider, coordinationMarker } from '../src/server/github.js';
import { config } from '../src/server/config.js';
import { demoSha, fixtureChange } from '../src/server/demo.js';
import type { Project } from '../src/shared/types.js';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString();
const cfg={...config({},true),demo:false,privateKey:key,clientId:'client',clientSecret:'not-real',origin:'https://pilot.example'};
const base=demoSha(1),head=demoSha(2),prHead=demoSha(3),direct=demoSha(4);
const project:Project={repo_id:'101',installation_id:'201',full_name:'owner/private',url:'https://github.com/owner/private',integration_branch:'main',default_branch:'main',prefix:'TASK',sequence:0,confirmed:true,init:'ready',last_sync:Date.now(),checkpoint:base,error:null,coverage_start:Date.now(),gaps:[]};
const repo={id:101,private:true,full_name:'owner/private',html_url:'https://github.com/owner/private',default_branch:'main',permissions:{pull:true}};

test('changed paths load only applicable scoped AGENTS.md files', () => {
  const inventory = new Set(['src/AGENTS.md', 'src/server/AGENTS.md', 'other/AGENTS.md']);
  assert.deepEqual(applicableScopedPolicies(['src/server/app.ts', 'README.md'], inventory), ['src/AGENTS.md', 'src/server/AGENTS.md']);
});
const wireCommit=(sha:string)=>({sha,commit:{message:'[TASK-1] change'},author:{id:1},html_url:`https://github.com/owner/private/commit/${sha}`});
const wirePr={number:1,id:55,title:'TASK-1 Implement feature',body:'Task: TASK-1',head:{sha:prHead,ref:'feature/work',repo:{id:101}},base:{sha:base,ref:'main',repo:{id:101}},user:{id:1},state:'closed',merged:true,merged_at:new Date().toISOString(),merge_commit_sha:head,draft:false,commits:1,changed_files:1,updated_at:new Date().toISOString(),html_url:'https://github.com/owner/private/pull/1'};
function transport(options:{partial?:boolean;missing?:boolean;empty?:boolean;treeTruncated?:boolean;direct?:boolean;failPr?:boolean;native?:boolean}={}) {
  const calls:{url:string;method:string;body:any;headers:any}[]=[];
  const http=async(input:any,init:any={})=>{
    const u=new URL(String(input)),p=u.pathname;calls.push({url:u.href,method:init.method??'GET',body:init.body?JSON.parse(init.body):null,headers:init.headers});
    const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status});
    if(p==='/login/oauth/access_token')return response({access_token:'user-access',refresh_token:'user-refresh',expires_in:28800,refresh_token_expires_in:15811200});
    if(p==='/user')return response({id:1,login:'owner'});
    if(p==='/app/installations/201/access_tokens')return response({token:'installation-token',expires_at:new Date(Date.now()+3600_000).toISOString()});
    if(p==='/repositories/101')return response(repo);
    if(options.native&&p==='/repos/owner/private/issues')return response([{number:1,id:900,title:'Issue one',body:'Acceptance criteria',state:'open',updated_at:new Date().toISOString(),closed_at:null,user:{id:1},assignees:[],labels:[],html_url:'https://github.com/owner/private/issues/1',repository:{id:101}},{number:2,id:901,title:'PR returned by Issues',body:'',state:'open',updated_at:new Date().toISOString(),pull_request:{url:'https://github.com/owner/private/pull/2'},html_url:'https://github.com/owner/private/pull/2'}]);
    if(options.native&&p==='/graphql')return response({data:{node:{__typename:'ProjectV2',id:'PVT_1',number:1,title:'Pilot',url:'https://github.com/orgs/owner/projects/1',fields:{nodes:[{__typename:'ProjectV2SingleSelectField',id:'PVTSSF_1',name:'Status',options:[{id:'custom',name:'Custom review'}]}],pageInfo:{hasNextPage:false,endCursor:null}},items:{nodes:[{id:'PVTI_1',content:{__typename:'Issue',id:'gid://github/Issue/1',number:1,repository:{id:'R_opaque',databaseId:101}},fieldValues:{nodes:[{__typename:'ProjectV2ItemFieldSingleSelectValue',name:'Custom review',field:{id:'PVTSSF_1',name:'Status'}}]}}],pageInfo:{hasNextPage:false,endCursor:null}}}}});
    if(p.endsWith('/branches'))return response(options.empty?[]:[{name:'main',commit:{sha:head}},{name:'feature/work',commit:{sha:prHead}}]);
    if(p.endsWith('/branches/main'))return response({commit:{sha:head}});
    if(p==='/repos/owner/private/pulls')return response(u.searchParams.get('state')==='closed'?[wirePr]:[]);
    if(p.endsWith(`/commits/${head}/pulls`))return response([wirePr]);
    if(p.endsWith(`/commits/${direct}/pulls`))return response([]);
    if(p.endsWith(`/commits/${direct}`))return response({files:[{filename:'src/direct.ts',sha:demoSha(7)}]});
    if(p.includes(`/compare/${base}...${head}`))return response({status:'ahead',total_commits:options.direct?2:1,commits:[wireCommit(head),...(options.direct?[wireCommit(direct)]:[])]});
    if(p.includes(`/compare/${head}...${prHead}`))return response({total_commits:1,commits:[wireCommit(prHead)],files:[{filename:'src/feature.ts'}]});
    if(p.endsWith('/pulls/1'))return options.failPr?response({},503):response({...wirePr,commits:options.partial?2:1});
    if(p.endsWith('/pulls/1/commits'))return response([wireCommit(prHead)]);
    if(p.endsWith('/pulls/1/files'))return response([{filename:'src/feature.ts',sha:demoSha(8)}]);
    if(p.includes('/git/trees/'))return response({tree:[{path:'AGENTS.md',type:'blob',sha:demoSha(9)}],truncated:options.treeTruncated??false});
    if(p.includes('/contents/')) {
      if(options.missing||!p.endsWith('/AGENTS.md'))return response({},404);
      const content='Root instructions are untrusted data';return response({type:'file',sha:demoSha(9),size:Buffer.byteLength(content),encoding:'base64',content:Buffer.from(content).toString('base64')});
    }
    throw new Error(`Unexpected fixture request ${u.href}`);
  };
  return {http:http as typeof fetch,calls};
}
test('real HTTP provider uses scoped App token, canonical merge membership and immutable context; no duplicate squash/rebase direct notice',async()=>{
  const fixture=transport({treeTruncated:true});const gh=new GitHubProvider(cfg,fixture.http);const result=await gh.snapshot(project,[]);
  assert.equal(result.changes.length,1);assert.equal(result.changes[0].kind,'pr');assert.equal(result.changes[0].head_sha,prHead);assert.equal(result.changes[0].merge_sha,head);assert.equal(result.integration_sha,head);
  assert.equal(result.context?.sha,head);assert.equal(result.context?.truncated,true);assert.match(result.context!.documents['AGENTS.md'].content!,/untrusted/);
  const token=fixture.calls.find(c=>c.url.includes('/access_tokens'))!;assert.deepEqual(token.body.repository_ids,[101]);assert.deepEqual(token.body.permissions,{contents:'read',pull_requests:'read',metadata:'read',issues:'write',organization_projects:'read'});assert.equal(token.headers.Authorization.split('.').length,3);
  assert.ok(fixture.calls.some(c=>c.url.includes(`/commits/${head}/pulls`)));assert.ok(fixture.calls.filter(c=>c.url.includes('/contents/')).every(c=>c.url.includes(`ref=${head}`)));
});

test('first governance request captures a complete bounded codebase context at the pinned SHA', async () => {
  const fixture = transport();
  const context = await new GitHubProvider(cfg, fixture.http).governanceRepositoryContext(project, head);
  assert.equal(context.codebase_complete, true);
  assert.equal(context.sha, head);
  assert.match(context.documents['AGENTS.md'].content!, /untrusted/);
});
test('direct integration commits are distinct and author email mapping is not authorization',async()=>{
  const f=transport({direct:true});const gh=new GitHubProvider(cfg,f.http);const result=await gh.snapshot(project,[]);const c=result.changes.find(c=>c.kind==='direct_commit')!;
  assert.equal(c.head_sha,direct);assert.equal(c.actor,null);assert.equal(c.commits[0].actor,'1');
});
test('partial PR collection cannot become complete; previous state retained on canonical failure',async()=>{
  const partial=transport({partial:true});await assert.rejects(()=>new GitHubProvider(cfg,partial.http).snapshot(project,[]),/truncated/);
  const failed=transport({failPr:true});const old=fixtureChange(1);const snapshot=await new GitHubProvider(cfg,failed.http).snapshot(project,[old]);assert.equal(snapshot.changes.find(c=>c.id===old.id)?.complete,false);assert.equal(snapshot.changes.find(c=>c.id===old.id)?.state,'open');
});
test('empty repository and missing context are honest waiting/warning states',async()=>{
  const empty=transport({empty:true});const snapshot=await new GitHubProvider(cfg,empty.http).snapshot({...project,checkpoint:null},[]);assert.equal(snapshot.empty,true);assert.equal(snapshot.context,null);
  const missing=transport({missing:true});const result=await new GitHubProvider(cfg,missing.http).snapshot(project,[]);assert.equal(result.context?.documents['AGENTS.md'].missing,true);assert.ok(result.context?.warnings.some(w=>w.includes('missing')));
});
test('real OAuth exchange/refresh and repository revalidation use user credentials, not installation credentials',async()=>{
  const f=transport();const gh=new GitHubProvider(cfg,f.http);const credentials=await gh.exchange('one-time-code');assert.equal(credentials.refresh_token,'user-refresh');assert.equal((await gh.user(credentials)).id,'1');assert.equal(await gh.userAccess(credentials,'101'),true);await gh.refresh(credentials);
  assert.equal(f.calls.find(c=>c.url.includes('/repositories/'))?.headers.Authorization,'Bearer user-access');assert.equal(f.calls.find(c=>c.body?.grant_type)?.body.refresh_token,'user-refresh');assert.ok(f.calls.every(c=>new URL(c.url).hostname==='github.com'||new URL(c.url).hostname==='api.github.com'));
});


test('governance Issue accepts the documented REST response without an embedded repository object',async()=>{
  const http=async(input:any,init:any={})=>{const u=new URL(String(input)),p=u.pathname;
    if(p==='/app/installations/201/access_tokens')return new Response(JSON.stringify({token:'installation-token',expires_at:new Date(Date.now()+3600_000).toISOString()}));
    if(p==='/repositories/101')return new Response(JSON.stringify(repo));
    if(p.endsWith('/branches/main'))return new Response(JSON.stringify({commit:{sha:head}}));
    if(p==='/repos/owner/private/issues/7')return new Response(JSON.stringify({id:907,number:7,body:'PR: #1',labels:[],user:{id:1},updated_at:new Date().toISOString(),repository_url:'https://api.github.com/repos/owner/private'}));
    throw new Error(`Unexpected governance Issue fixture request ${u.href}`);
  };
  const issue=await new GitHubProvider(cfg,http as typeof fetch).governanceIssue(7);assert.equal(issue.id,'907');assert.equal(issue.repo_id,'101');
});

test('GitHub Issues REST excludes PRs and Projects v2 preserves raw status with App-token read access',async()=>{
  const nativeCfg={...cfg,projectNodeId:'PVT_1'};const fixture=transport({native:true});const result=await new GitHubProvider(nativeCfg,fixture.http).snapshot(project,[]);
  assert.deepEqual(result.issues?.map(issue=>issue.number),[1]);assert.equal(result.project?.node_id,'PVT_1');assert.equal(result.project?.status_field_name,'Status');assert.equal(result.project?.items[0].status,'Custom review');
  const graphql=fixture.calls.find(call=>call.url.endsWith('/graphql'))!;assert.equal(graphql.body.variables.nodeId,'PVT_1');
  assert.match(graphql.body.query, /repository\{databaseId\}/); // GraphQL node IDs are not REST numeric IDs.
  assert.equal(result.project?.items[0].repo_id, '101');
});


test('Project null or partial item nodes fail closed before snapshot application',async()=>{
  const nativeCfg={...cfg,projectNodeId:'PVT_1'};const fixture=transport({native:true});
  const nullItem=async(input:any,init:any={})=>{if(new URL(String(input)).pathname==='/graphql'){const response=await fixture.http(input,init);const body=await response.json();body.data.node.items.nodes[0].content=null;return new Response(JSON.stringify(body));}return fixture.http(input,init);};
  await assert.rejects(()=>new GitHubProvider(nativeCfg,nullItem as typeof fetch).snapshot(project,[]),/incomplete item content/);
  const missingValues=async(input:any,init:any={})=>{if(new URL(String(input)).pathname==='/graphql'){const response=await fixture.http(input,init);const body=await response.json();delete body.data.node.items.nodes[0].fieldValues.nodes;return new Response(JSON.stringify(body));}return fixture.http(input,init);};
  await assert.rejects(()=>new GitHubProvider(nativeCfg,missingValues as typeof fetch).snapshot(project,[]),/incomplete item field values/);
  const drift=async(input:any,init:any={})=>{if(new URL(String(input)).pathname==='/graphql'){const response=await fixture.http(input,init);const body=await response.json();body.data.node.id='PVT_other';return new Response(JSON.stringify(body));}return fixture.http(input,init);};
  await assert.rejects(()=>new GitHubProvider(nativeCfg,drift as typeof fetch).snapshot(project,[]),/not found or is inaccessible/);
});

test('REST pagination accepts exactly 10,000 records after a terminal empty-page check',async()=>{
  let requests=0;
  const http=async(input:any)=>{const page=Number(new URL(String(input)).searchParams.get('page'));requests++;const values=page<=100?Array.from({length:100},(_,index)=>({id:`item-${(page-1)*100+index}`})):[];return new Response(JSON.stringify({commits:values,total_commits:10_000}));};
  const result=await new GitHubProvider(cfg,http as typeof fetch).pages('/repos/owner/private/items','token','commits');
  assert.equal(result.length,10_000);assert.equal(requests,101);
});

test('bounded collection pagination stops before retaining an oversized aggregate',async()=>{
  const http=async()=>new Response(JSON.stringify([{id:'one',patch:'x'.repeat(101)}]));
  await assert.rejects(()=>new GitHubProvider(cfg,http as typeof fetch).pages('/repos/owner/private/files','token',undefined,{maxBytes:100}),/bounded aggregate/);
});

test('GraphQL errors fail the complete native observation instead of returning partial data',async()=>{
  const nativeCfg={...cfg,projectNodeId:'PVT_1'};const fixture=transport({native:true});const failing=async(input:any,init:any={})=>new URL(String(input)).pathname==='/graphql'?new Response(JSON.stringify({data:{node:null},errors:[{message:'denied'}]})):fixture.http(input,init);
  await assert.rejects(()=>new GitHubProvider(nativeCfg,failing as typeof fetch).snapshot(project,[]),/Projects query failed/);
});

test('app-owned coordination comments are idempotent, update in place, and reject spoofed markers',async()=>{
  const comments:any[]=[];let posts=0,patches=0;const nativeCfg={...cfg,projectNodeId:'PVT_1'};
  const http=async(input:any,init:any={})=>{const u=new URL(String(input)),p=u.pathname;
    if(p==='/app/installations/201/access_tokens')return new Response(JSON.stringify({token:'installation-token',expires_at:new Date(Date.now()+3600_000).toISOString()}));
    if(p==='/app'){const authorization=String(init.headers?.Authorization??init.headers?.authorization??'');assert.match(authorization,/^Bearer [^.]+[.][^.]+[.][^.]+$/);assert.notEqual(authorization,'Bearer installation-token');return new Response(JSON.stringify({id:777,slug:'kapo'}));}
    if(p==='/repositories/101')return new Response(JSON.stringify(repo));
    if(p.endsWith('/branches/main'))return new Response(JSON.stringify({commit:{sha:head}}));
    if(p==='/repos/owner/private/issues/1/comments'&&(!init.method||init.method==='GET'))return new Response(JSON.stringify(comments));
    if(p==='/repos/owner/private/issues/1/comments'&&init.method==='POST'){posts++;const body=JSON.parse(init.body);const comment={id:900+posts,body:body.body,user:{id:888,login:'kapo[bot]',type:'Bot'}};comments.push(comment);return new Response(JSON.stringify(comment),{status:201});}
    if(p==='/repos/owner/private/issues/comments/901'&&init.method==='PATCH'){patches++;const body=JSON.parse(init.body);comments[0].body=body.body;return new Response(JSON.stringify(comments[0]));}
    throw new Error(`Unexpected comment fixture request ${u.href}`);
  };
  const gh=new GitHubProvider(nativeCfg,http as typeof fetch);const change=fixtureChange(1,{number:1});
  const body=coordinationMarker('101',1)+'\\n<!-- kapo:change=101:pr:1:issue=1 -->\\nUpdated';
  await gh.maintainComment(change,body);await gh.maintainComment(change,body);assert.equal(posts,1);
  await gh.maintainComment(change,body.replace('Updated','Changed'));assert.equal(patches,1);
  comments.splice(0,comments.length,{id:902,body:coordinationMarker('101',1)+'\nspoof',user:{id:777,login:'human',type:'User'}});
  await assert.rejects(()=>gh.maintainComment(change,body),/unverified human/);assert.equal(posts,1);
});


test('Main Agent PR reviews are App-authored and idempotent', async () => {
  const reviews: any[] = []; let posts = 0;
  const http: typeof fetch = async (input, init: any = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === '/app/installations/201/access_tokens') return new Response(JSON.stringify({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    if (path === '/app') return new Response(JSON.stringify({ id: 777, slug: 'kapo' }));
    if (path === '/repositories/101') return new Response(JSON.stringify(repo));
    if (path === '/repos/owner/private/branches/main') return new Response(JSON.stringify({ commit: { sha: head } }));
    if (path === '/repos/owner/private/pulls/4/reviews' && (!init.method || init.method === 'GET')) return new Response(JSON.stringify(reviews));
    if (path === '/repos/owner/private/pulls/4/reviews' && init.method === 'POST') {
      posts++; const request = JSON.parse(init.body); const review = { id: 950, body: request.body, state: 'APPROVED', user: { id: 888, login: 'kapo[bot]', type: 'Bot' } }; reviews.push(review); return new Response(JSON.stringify(review), { status: 200 });
    }
    throw new Error(`Unexpected review fixture request ${String(input)}`);
  };
  const provider = new GitHubProvider({ ...cfg, projectNodeId: 'PVT_1' }, http);
  const body = '<!-- vf-kapo:main-review:101:fixture -->\nApproved';
  await provider.maintainGovernanceReview(4, body, 'APPROVE');
  await provider.maintainGovernanceReview(4, body, 'APPROVE');
  assert.equal(posts, 1);
});


test('Project pagination rejects malformed metadata/null fields and bounds empty pages', async () => {
  const nativeCfg = { ...cfg, projectNodeId: 'PVT_1' };
  for (const mutate of [
    (node: any) => { node.fields.pageInfo = {}; },
    (node: any) => { node.items.pageInfo = {}; },
    (node: any) => { node.items.pageInfo.hasNextPage = 'false'; },
    (node: any) => { node.items.pageInfo = { hasNextPage: true, endCursor: 123 }; },
    (node: any) => { node.fields.nodes.push(null); },
  ]) {
    const fixture = transport({ native: true });
    const http: typeof fetch = async (input, init) => {
      const response = await fixture.http(input, init);
      if (new URL(String(input)).pathname !== '/graphql') return response;
      const body = await response.json(); mutate(body.data.node);
      return new Response(JSON.stringify(body));
    };
    await assert.rejects(() => new GitHubProvider(nativeCfg, http).snapshot(project, []), /collection is incomplete/);
  }
  const fixture = transport({ native: true }); let requests = 0;
  const http: typeof fetch = async (input, init) => {
    const response = await fixture.http(input, init);
    if (new URL(String(input)).pathname !== '/graphql') return response;
    const body = await response.json(); requests++;
    body.data.node.items = { nodes: [], pageInfo: { hasNextPage: true, endCursor: `unique-${requests}` } };
    return new Response(JSON.stringify(body));
  };
  await assert.rejects(() => new GitHubProvider(nativeCfg, http).snapshot(project, []), /pilot page limit/);
  assert.equal(requests, 100);
});

test('Project fields and items finish pagination independently', async () => {
  const fixture = transport({ native: true }); let requests = 0;
  const http: typeof fetch = async (input, init) => {
    const response = await fixture.http(input, init);
    if (new URL(String(input)).pathname !== '/graphql') return response;
    const body = await response.json(); requests++;
    const variables = JSON.parse(String(init?.body)).variables;
    // Fields end on page 2; items end on page 3. Subsequent queries re-read
    // the first fields page, which must not reactivate its completed cursor.
    body.data.node.fields.pageInfo = variables.fieldCursor === 'fields-1' ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'fields-1' };
    body.data.node.items.nodes[0].id = `item-${requests}`;
    body.data.node.items.nodes[0].content.number = requests;
    body.data.node.items.pageInfo = { hasNextPage: requests < 3, endCursor: requests < 3 ? `items-${requests}` : null };
    return new Response(JSON.stringify(body));
  };
  const snapshot = await new GitHubProvider({ ...cfg, projectNodeId: 'PVT_1' }, http).snapshot(project, []);
  assert.equal(requests, 3); assert.equal(snapshot.project?.items.length, 3);
});

test('governance bounds aggregate commit bytes before collecting subsequent evidence', async () => {
  const fixture = transport(); let pages = 0;
  const http: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/pulls/1/commits')) {
      pages++;
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...wireCommit(demoSha(pages * 100 + index)), commit: { message: 'x'.repeat(12_000) } }))));
    }
    return fixture.http(input, init);
  };
  await assert.rejects(() => new GitHubProvider(cfg, http).governanceEvidence(project, 1), /bounded aggregate/);
  assert.equal(pages, 2);
  assert.ok(!fixture.calls.some(call => new URL(call.url).pathname.endsWith('/files')));
});

test('collection item bound also rejects a single oversized terminal page', async () => {
  const http: typeof fetch = async () => new Response(JSON.stringify([{ id: 1 }, { id: 2 }]));
  await assert.rejects(() => new GitHubProvider(cfg, http).pages('/items', 'fixture-token', undefined, { maxItems: 1 }), /bounded item limit/);
});
