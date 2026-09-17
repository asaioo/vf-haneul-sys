import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor, Member, Scope } from '../shared/types.js';
import type { Config } from './config.js';
import type { Provider, UserCredentials } from './github.js';
import { ApiError, Store } from './db.js';
export const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export function encrypt(v:unknown,key:Buffer) {const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([c.update(JSON.stringify(v)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
export function decrypt<T>(v:string,key:Buffer):T {const b=Buffer.from(v,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
export function equal(a:string,b:string) {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function assertScope(a:Actor,scope:Scope) {if(!a.scopes.includes(scope))throw new ApiError(403,`Required scope: ${scope}`);}
export function admin(a:Actor) {if(a.role!=='developer'||a.agent)throw new ApiError(403,'Human Developer authority required');}
export function editTask(a:Actor,t:{owner:string|null}) {assertScope(a,'tasks:write');if(a.role==='viewer'||a.role!=='developer'&&t.owner!==a.id)throw new ApiError(403,'Task ownership required');}
export function developer(a:Actor) {if(a.role!=='developer'||a.agent)throw new ApiError(403,'Human Developer required for manual Done, reopen, or supersession');}
declare module 'fastify' {interface FastifyRequest { actor:Actor; csrfToken?:string; }}
export class Auth {
  private checking=new Map<string,Promise<void>>();
  constructor(private s:Store,private cfg:Config,private provider:Provider) {}
  async revalidate(member:Member) {
    if(member.access_checked>Date.now()-300_000)return;
    let work=this.checking.get(member.id);if(work)return work;
    work=(async()=>{
      try {
        if(!member.credentials)throw new ApiError(401,'Sign in with GitHub to authorize repository access');
        let c=decrypt<UserCredentials>(member.credentials,this.cfg.encryptionKey);
        if(c.expires_at<Date.now()+60_000){c=await this.provider.refresh(c);member.credentials=encrypt(c,this.cfg.encryptionKey);}
        if(!await this.provider.userAccess(c,this.cfg.repoId))throw new ApiError(403,'GitHub repository access denied');
        const current=this.s.get('member',member.id);if(!current?.active)throw new ApiError(403,'Membership revoked');
        current.credentials=member.credentials;current.access_checked=Date.now();this.s.put('member',current.id,current);
      } catch(e) {const current=this.s.get('member',member.id);if(current){current.access_checked=0;this.s.put('member',current.id,current);}throw e instanceof ApiError?e:new ApiError(401,'GitHub access revalidation failed; reauthorize');}
    })();this.checking.set(member.id,work);try{await work;}finally{this.checking.delete(member.id);}
  }
  async authenticate(req:FastifyRequest) {
    let id:string;let agent:string|undefined;let scopes:Scope[]=['read','tasks:write','links:write','explanations:write'];let credentialHash:string;
    if(req.headers.authorization) {
      if(!req.headers.authorization.startsWith('Bearer '))throw new ApiError(401,'Bearer token required');
      credentialHash=hash(req.headers.authorization.slice(7));
      const row=this.s.db.prepare('SELECT * FROM agent_token WHERE hash=?').get(credentialHash) as any;
      if(!row||row.revoked||row.expires<Date.now())throw new ApiError(401,'Token expired or revoked');
      id=row.member_id;agent=row.label;scopes=JSON.parse(row.scopes);
    } else {
      credentialHash=hash(req.cookies.kapo_session??'');
      const row=this.s.db.prepare('SELECT * FROM session WHERE hash=?').get(credentialHash) as any;
      if(!row||row.expires<Date.now())throw new ApiError(401,'Sign in required');
      id=row.member_id;req.csrfToken=row.csrf;
      if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(req.headers.origin!==this.cfg.origin||!equal(String(req.headers['x-csrf-token']??''),row.csrf)))throw new ApiError(403,'CSRF verification failed');
    }
    const m=this.s.get('member',id);if(!m?.active)throw new ApiError(403,'Active membership required');
    await this.revalidate(m);
    const credential=this.s.db.prepare(req.headers.authorization?'SELECT * FROM agent_token WHERE hash=?':'SELECT * FROM session WHERE hash=?').get(credentialHash) as any;
    if(!credential||credential.revoked||credential.expires<Date.now())throw new ApiError(401,req.headers.authorization?'Token expired or revoked':'Sign in required');
    const current=this.s.get('member',id);if(!current?.active)throw new ApiError(403,'Active membership required');
    req.actor={id,role:current.role,agent,scopes};assertScope(req.actor,'read');
  }
  session(id:string) {const token=secret(),csrf=secret();this.s.db.prepare('INSERT INTO session VALUES(?,?,?,?)').run(hash(token),id,csrf,Date.now()+12*3600_000);return {token,csrf};}
  routes(app:FastifyInstance) {
    const cookie={httpOnly:true,secure:!this.cfg.demo,sameSite:'lax' as const,path:'/',maxAge:12*3600};
    app.get('/auth/github',async(req,reply)=>{
      if(this.cfg.demo)throw new ApiError(400,'Use explicitly labeled demo sign-in');
      const state=secret();this.s.db.prepare('INSERT INTO oauth_state VALUES(?,?)').run(hash(state),Date.now()+600_000);
      reply.setCookie('kapo_oauth',state,{...cookie,maxAge:600});
      return reply.redirect(`https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(this.cfg.clientId)}&redirect_uri=${encodeURIComponent(this.cfg.origin+'/auth/github/callback')}&state=${state}`);
    });
    app.get('/auth/github/callback',async(req,reply)=>{
      if(this.cfg.demo)throw new ApiError(400,'GitHub OAuth disabled in demo');
      const q=req.query as {state?:string;code?:string};
      if(!q.state||!q.code||q.code.length>1024||!equal(q.state,req.cookies.kapo_oauth??''))throw new ApiError(403,'Invalid OAuth state');
      const row=this.s.db.prepare('DELETE FROM oauth_state WHERE hash=? AND expires>? RETURNING hash').get(hash(q.state),Date.now());
      if(!row)throw new ApiError(403,'Expired or replayed OAuth state');
      reply.clearCookie('kapo_oauth',{path:'/'});
      const credentials=await this.provider.exchange(q.code),user=await this.provider.user(credentials);
      const known=this.s.get('member',user.id);
      if(!known&&!this.cfg.bootstrapIds.includes(user.id))throw new ApiError(403,'Membership must be explicitly granted');
      if(known&&!known.active)throw new ApiError(403,'Current membership and GitHub read access required');
      if(!await this.provider.userAccess(credentials,this.cfg.repoId))throw new ApiError(403,'Current membership and GitHub read access required');
      const current=this.s.get('member',user.id);
      if(known&&!current||current&&!current.active)throw new ApiError(403,'Current membership and GitHub read access required');
      const member=current??{...user,role:'developer' as const,active:true,access_checked:0};
      member.login=user.login;member.credentials=encrypt(credentials,this.cfg.encryptionKey);member.access_checked=Date.now();this.s.put('member',member.id,member);
      const session=this.session(member.id);reply.setCookie('kapo_session',session.token,cookie);return reply.redirect('/');
    });
    if(this.cfg.demo)app.post('/auth/demo',async(req,reply)=>{
      if(req.headers.origin!==this.cfg.origin)throw new ApiError(403,'Demo sign-in requires same-origin loopback request');
      const session=this.session('1');reply.setCookie('kapo_session',session.token,cookie);return {demo:true,csrf_token:session.csrf};
    });
    app.post('/api/auth/logout',async(req,reply)=>{this.s.db.prepare('DELETE FROM session WHERE hash=?').run(hash(req.cookies.kapo_session??''));reply.clearCookie('kapo_session',{path:'/'});return {ok:true};});
  }
}
