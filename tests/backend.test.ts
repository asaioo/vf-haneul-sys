import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { FakeProvider, seedDemo, fixtureChange, demoSha } from '../src/server/demo.js';
import { applySnapshot, coordinate, issueReferences } from '../src/server/coordinator.js';
import { appJwt, ProviderError } from '../src/server/github.js';
import { decrypt, encrypt, hash } from '../src/server/auth.js';
import { Worker } from '../src/server/worker.js';
import type { Actor, Change } from '../src/shared/types.js';

const admin: Actor = { id: '1', role: 'developer', scopes: ['read', 'tasks:write', 'links:write', 'explanations:write'] };
const cfg = config({}, true);

function setup() {
  const store = new Store(':memory:');
  const provider = new FakeProvider();
  seedDemo(store, cfg, provider);
  return { store, provider };
}

function update(store: Store, provider: FakeProvider, changes: Change[]) {
  provider.data.changes = changes;
  provider.data.branches = ['main', ...changes.filter(change => change.state !== 'deleted').map(change => change.branch)];
  store.tx(() => applySnapshot(store, provider.data));
}

async function api() {
  const fixture = setup();
  const built = await buildApp(cfg, fixture.store, fixture.provider, { worker: false });
  const session = built.auth.session('1');
  const headers = { cookie: `kapo_session=${session.token}`, origin: cfg.origin, 'x-csrf-token': session.csrf };
  return { ...fixture, app: built.app, auth: built.auth, headers, close: async () => { await built.app.close(); fixture.store.close(); } };
}

test('Issue references are exact, same-repository, and passive', () => {
  const change = fixtureChange(7, { title: 'Fixes #12 and owner/private#13', body: 'Unrelated #14\nTask: other/repo#15\nhttps://github.com/owner/private/issues/16' });
  assert.deepEqual(issueReferences(change, 'owner/private').numbers, [12, 13, 16]);
});

test('native snapshot preserves raw/custom and unset Project statuses and warns on missing membership', () => {
  const { store, provider } = setup();
  const issue = provider.data.issues![0];
  const snapshot = structuredClone(provider.data);
  snapshot.issues = [issue, { ...issue, id: '101:issue:99', number: 99, title: 'Not in Project', url: 'https://example.invalid/FAKE/demo/issues/99' }];
  snapshot.project = { ...snapshot.project!, items: [{ ...snapshot.project!.items[0], status: 'Custom review' }, { ...snapshot.project!.items[0], id: 'PVTITEM_demo_unset', issue_id: 'gid://github/Issue/99', issue_number: 99, status: null }] };
  store.tx(() => applySnapshot(store, snapshot));
  assert.equal(store.get('project_item', 'PVTITEM_demo_1')?.status, 'Custom review');
  assert.equal(store.get('project_item', 'PVTITEM_demo_unset')?.status, null);
  assert.ok(store.all('action_item').some(item => item.kind === 'issue_missing_project' && item.subject.endsWith(':2')));
  assert.ok(store.all('action_item').some(item => item.kind === 'issue_unset_project_status' && item.subject.endsWith(':99:status')));
  store.close();
});

test('native local task/status/link writes return explicit GitHub guidance without local mutation', async () => {
  const f = await api();
  try {
    for (const request of [
      { method: 'POST' as const, url: '/api/tasks', payload: { title: 'local task', type: 'bug' } },
      { method: 'PATCH' as const, url: '/api/tasks/legacy', payload: { expected_version: 1, title: 'edit' } },
      { method: 'POST' as const, url: '/api/tasks/legacy/status', payload: { expected_version: 1, action: 'set', status: 'done', reason: 'close' } },
      { method: 'POST' as const, url: '/api/tasks/legacy/links', payload: { expected_version: 1, change_id: '101:pr:1', expected_change_version: 1, reason: 'link' } },
      { method: 'POST' as const, url: '/api/tasks/legacy/completion', payload: { expected_version: 1, change_id: null } },
    ]) {
      const response = await f.app.inject({ ...request, headers: f.headers });
      assert.equal(response.statusCode, 410, `${request.method} ${request.url}: ${response.body}`);
      assert.match(response.json().error, /GitHub Issues/);
    }
    assert.equal(f.store.all('task').length, 0);
  } finally { await f.close(); }
});

test('native read APIs expose bounded Issues, raw Project facts, and Inbox warnings', async () => {
  const f = await api();
  try {
    const first = await f.app.inject({ url: '/api/issues?limit=1&offset=0', headers: f.headers });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().items.length, 1);
    assert.equal(first.json().next_offset, 1);
    const all = await f.app.inject({ url: '/api/issues?limit=100', headers: f.headers });
    assert.equal(all.json().items.length, 2);
    assert.equal(all.json().items.find((issue: any) => issue.number === 1).project_item.status, 'Todo');
    assert.equal(all.json().items.find((issue: any) => issue.number === 2).project_item, null);
    const inbox = await f.app.inject({ url: '/api/inbox?limit=100', headers: f.headers });
    assert.equal(inbox.statusCode, 200);
    assert.ok(inbox.json().items.some((item: any) => item.kind === 'issue_missing_project'));
    assert.ok(inbox.json().items.some((item: any) => item.kind === 'untracked_change'));
  } finally { await f.close(); }
});

test('authentication, CSRF, member access revocation, and scoped token revocation remain enforced', async () => {
  const f = await api();
  try {
    assert.equal((await f.app.inject('/api/issues')).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/project/resync', headers: { cookie: f.headers.cookie }, payload: {} })).statusCode, 403);
    const token = await f.app.inject({ method: 'POST', url: '/api/tokens', headers: f.headers, payload: { label: 'read only', scopes: ['read'], expires_days: 1 } });
    assert.equal(token.statusCode, 200, token.body);
    const value = token.json();
    assert.equal((await f.app.inject({ url: '/api/issues', headers: { authorization: `Bearer ${value.token}` } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: `Bearer ${value.token}` }, payload: { title: 'forbidden', type: 'chore' } })).statusCode, 410);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/project/resync', headers: { authorization: `Bearer ${value.token}` }, payload: {} })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/tokens/${value.id}`, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/issues', headers: { authorization: `Bearer ${value.token}` } })).statusCode, 401);
    const member = f.store.get('member', '1')!; member.access_checked = 0; f.store.put('member', member.id, member); f.provider.access = false;
    assert.equal((await f.app.inject({ url: '/api/issues', headers: f.headers })).statusCode, 403);
    member.active = false; f.store.put('member', member.id, member);
    assert.equal((await f.app.inject({ url: '/api/issues', headers: f.headers })).statusCode, 403);
  } finally { await f.close(); }
});

test('session and token revocation during awaited repository access deny the request', async () => {
  const f = await api();
  try {
    const original = f.provider.userAccess.bind(f.provider);
    const token = (await f.app.inject({ method: 'POST', url: '/api/tokens', headers: f.headers, payload: { label: 'race', scopes: ['read'], expires_days: 1 } })).json();
    const member = f.store.get('member', '1')!; member.access_checked = 0; f.store.put('member', member.id, member);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve }); const gate = new Promise<void>(resolve => { release = resolve });
    f.provider.userAccess = async (...args) => { entered(); await gate; return original(...args); };
    const pending = f.app.inject({ url: '/api/issues', headers: f.headers }); await started;
    f.store.db.prepare('DELETE FROM session WHERE hash=?').run(hash(f.headers.cookie.split('=')[1])); release();
    assert.equal((await pending).statusCode, 401);
    member.access_checked = 0; f.store.put('member', member.id, member);
    let tokenEntered!: () => void; let tokenRelease!: () => void;
    const tokenStarted = new Promise<void>(resolve => { tokenEntered = resolve }); const tokenGate = new Promise<void>(resolve => { tokenRelease = resolve });
    f.provider.userAccess = async (...args) => { tokenEntered(); await tokenGate; return original(...args); };
    const tokenPending = f.app.inject({ url: '/api/issues', headers: { authorization: `Bearer ${token.token}` } }); await tokenStarted;
    f.store.db.prepare('UPDATE agent_token SET revoked=? WHERE hash=?').run(Date.now(), token.id); tokenRelease();
    assert.equal((await tokenPending).statusCode, 401);
  } finally { await f.close(); }
});

test('OAuth callback preserves membership changes made during access validation', async () => {
  const oauthCfg = { ...cfg, demo: false, origin: 'https://pilot.example', projectNodeId: 'PVT_demo', bootstrapIds: ['1'] };
  const store = new Store(':memory:');
  const provider = new FakeProvider();
  (provider as any).fake = false;
  store.put('member', '1', { id: '1', login: 'Existing user', role: 'developer', active: true, access_checked: 0 });
  const built = await buildApp(oauthCfg, store, provider, { worker: false });
  try {
    const start = await built.app.inject('/auth/github');
    assert.equal(start.statusCode, 302);
    const cookie = String(start.headers['set-cookie'] ?? '');
    const state = cookie.match(/kapo_oauth=([^;]+)/)?.[1];
    assert.ok(state);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve });
    const gate = new Promise<void>(resolve => { release = resolve });
    const original = provider.userAccess.bind(provider);
    provider.userAccess = async (...args) => { entered(); await gate; return original(...args); };
    const callback = built.app.inject({ url: `/auth/github/callback?state=${encodeURIComponent(state)}&code=oauth-code`, headers: { cookie: `kapo_oauth=${state}` } });
    await started;
    const member = store.get('member', '1')!; member.active = false; member.role = 'viewer'; store.put('member', member.id, member);
    release();
    assert.equal((await callback).statusCode, 403);
    assert.equal(store.get('member', '1')?.active, false);
    assert.equal(store.get('member', '1')?.role, 'viewer');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM session').get() as any).count, 0);
  } finally { await built.app.close(); store.close(); }
});

test('webhook signature, identity, durable deduplication, and old-event safety remain enforced', async () => {
  const f = await api();
  try {
    const raw = JSON.stringify({ installation: { id: 201 }, repository: { id: 101 }, pull_request: { number: 1, state: 'closed' } });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'native-delivery-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex')}` };
    assert.equal((await f.app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: raw })).statusCode, 202);
    assert.equal((await f.app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: raw })).json().duplicate, true);
    assert.equal(f.store.all('event_job').filter(job => job.id === 'github:native-delivery-1').length, 1);
    assert.equal((await f.app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: `${raw} ` })).statusCode, 401);
    const foreign = raw.replace('101', '999'); headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', cfg.webhookSecret).update(foreign).digest('hex')}`;
    assert.equal((await f.app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: foreign })).statusCode, 403);
  } finally { await f.close(); }
});

test('resync idempotency and durable worker leases/backoff preserve observations', async () => {
  const f = await api();
  try {
    const headers = { ...f.headers, 'idempotency-key': 'native-resync-1' };
    const first = await f.app.inject({ method: 'POST', url: '/api/project/resync', headers, payload: { retry_failed: false } });
    const repeat = await f.app.inject({ method: 'POST', url: '/api/project/resync', headers, payload: { retry_failed: false } });
    assert.equal(first.statusCode, 200); assert.deepEqual(repeat.json(), first.json());
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/project/resync', headers, payload: { retry_failed: true } })).statusCode, 409);
    for (const job of f.store.all('event_job')) { job.state = 'done'; f.store.put('event_job', job.id, job); }
    const id = f.store.enqueue('reconcile'); const job = f.store.get('event_job', id)!; job.state = 'running'; job.lease_until = 0; job.lease_token = 'expired'; f.store.put('event_job', id, job);
    f.provider.failure = new ProviderError('Rate limited', 429, Date.now() + 60_000);
    await new Worker(f.store, f.provider).tick();
    assert.equal(f.store.get('event_job', id)?.state, 'queued'); assert.equal(f.store.get('event_job', id)?.attempts, 0); assert.ok(f.store.get('github_issue', '101:issue:1'));
    f.provider.failure = null; const retry = f.store.get('event_job', id)!; retry.next_at = 0; f.store.put('event_job', id, retry); await new Worker(f.store, f.provider).tick();
    assert.equal(f.store.get('event_job', id)?.state, 'done');
  } finally { await f.close(); }
});

test('online backup/restore retains native observations, jobs, audit, and append-only audit protection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kapo-native-test-')); const { store } = setup(); const job = store.enqueue('reconcile'); store.audit('1', 'test.native', 'project', { ok: true });
  try {
    const path = join(dir, 'backup.sqlite'); await backup(store.db, path); const restored = new Store(path);
    assert.ok(restored.get('github_issue', '101:issue:1')); assert.equal(restored.get('event_job', job)?.state, 'queued'); assert.ok(restored.db.prepare('SELECT 1 FROM audit_entry').get());
    assert.throws(() => restored.db.exec("UPDATE audit_entry SET actor='tampered'"), /append only/); restored.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('AES-GCM encryption is randomized/authenticated and App JWT lifetime is bounded', () => {
  const key = Buffer.alloc(32, 7), payload = { access_token: 'private', refresh_token: 'more-private' }; const a = encrypt(payload, key), b = encrypt(payload, key);
  assert.notEqual(a, b); assert.deepEqual(decrypt(a, key), payload); const bytes = Buffer.from(a, 'base64'); bytes[30] ^= 1; assert.throws(() => decrypt(bytes.toString('base64'), key));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(); const jwt = appJwt('123', pem, 1_000_000); const [h, p, signature] = jwt.split('.');
  assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(keys.publicKey, Buffer.from(signature, 'base64url')), true); const claims = JSON.parse(Buffer.from(p, 'base64url').toString()); assert.equal(claims.exp - claims.iat, 600); assert.equal(claims.iss, '123');
});


test('worker cleanup scrubs raw event payloads but preserves durable governance and comment routing', async () => {
  const { store, provider } = setup();
  try {
    const old = Date.now() - 8 * 86_400_000;
    const rawId = store.enqueue('issues', { raw: 'private webhook data' }, 'old-raw-event');
    const governanceId = store.enqueue('governance_review', { request_id: 'governance:request-1' }, 'old-governance-job');
    const commentId = store.enqueue('github_comment', { comment_id: 'comment-1', change_id: 'change-1' }, 'old-comment-job');
    for (const id of [rawId, governanceId, commentId]) { const job = store.get('event_job', id)!; job.created_at = old; job.state = 'done'; store.put('event_job', id, job); }
    await new Worker(store, provider).tick();
    assert.equal(store.get('event_job', rawId)?.payload, '{}');
    assert.equal(store.get('event_job', governanceId)?.payload, '{"request_id":"governance:request-1"}');
    assert.equal(store.get('event_job', commentId)?.payload, '{"comment_id":"comment-1","change_id":"change-1"}');
  } finally { store.close(); }
});

test('demo and production boundaries remain explicit', async () => {
  assert.equal(cfg.dbPath.endsWith('data/github-demo.sqlite'), true); assert.throws(() => config({ NODE_ENV: 'production' }, true), /impossible/); assert.throws(() => config({}, false), /Missing/);
  const { store, provider } = setup(); await assert.rejects(() => buildApp({ ...cfg, demo: false }, store, provider, { worker: false }), /Fake provider/); store.close();
});


test('legacy null or unmarked Project rows cannot be reinterpreted by onboarding', async () => {
  const { store, provider } = setup();
  const original = store.get('project', '1')!;
  const nativeCfg = { ...cfg, projectNodeId: original.project_node_id! };
  const built = await buildApp(nativeCfg, store, provider, { worker: false });
  const session = built.auth.session('1');
  try {
    for (const confirmed of [false, true]) for (const project_node_id of [null, undefined, 'PVT_legacy']) {
      const legacy = { ...original, confirmed, source_of_truth: 'legacy' as const, project_node_id };
      store.put('project', '1', legacy);
      const before = store.get('project', '1');
      const response = await built.app.inject({ method: 'POST', url: '/api/project/onboarding', headers: { cookie: `kapo_session=${session.token}`, origin: cfg.origin, 'x-csrf-token': session.csrf }, payload: { repository_id: cfg.repoId, installation_id: cfg.installationId, confirm: true } });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /legacy local-PM/);
      assert.deepEqual(store.get('project', '1'), before);
    }
  } finally { await built.app.close(); store.close(); }
});

test('production startup rejects legacy null Project node without changing its data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kapo-legacy-startup-'));
  const path = join(dir, 'legacy.sqlite'); const key = join(dir, 'fixture-key.pem');
  writeFileSync(key, 'Not a real key: startup must reject before provider authentication.');
  const { store: original } = setup();
  const legacy = { ...original.get('project', '1')!, source_of_truth: 'legacy' as const, project_node_id: null };
  original.close();
  const store = new Store(path); store.put('project', '1', legacy); store.close();
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/server/main.ts', import.meta.url))], { timeout: 10_000, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production', APP_ORIGIN: 'https://pilot.example', DATABASE_PATH: path, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), GITHUB_WEBHOOK_SECRET: 'fixture-only-webhook-secret-at-least-32-bytes', GITHUB_APP_ID: '123', GITHUB_PRIVATE_KEY_PATH: key, GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', GITHUB_REPOSITORY_ID: '101', GITHUB_INSTALLATION_ID: '201', GITHUB_PROJECT_NODE_ID: 'PVT_test', BOOTSTRAP_GITHUB_IDS: '1' } });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, /Legacy local-PM database detected/);
    const restored = new Store(path);
    try { assert.deepEqual(restored.get('project', '1'), legacy); } finally { restored.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Issue lists, counts and coordination ignore retained foreign repository rows', async () => {
  const f = await api();
  try {
    const issue = f.store.all('github_issue')[0], item = f.store.all('project_item')[0];
    f.store.put('github_issue', 'foreign', { ...issue, id: 'foreign', repo_id: '999', number: 987 });
    f.store.put('project_item', 'foreign-item', { ...item, id: 'foreign-item', repo_id: '999', issue_number: 987 });
    f.store.put('project_item', 'old-project-item', { ...item, id: 'old-project-item', project_node_id: 'PVT_old' });
    coordinate(f.store);
    const response = await f.app.inject({ url: '/api/issues', headers: f.headers });
    assert.equal(response.json().items.length, 2);
    assert.ok(response.json().items.every((value: any) => value.repo_id === '101'));
    const info = await f.app.inject({ url: '/api/project', headers: f.headers });
    assert.equal(info.json().issues, 2); assert.equal(info.json().project_items, 1);
    assert.ok(!f.store.all('action_item').some(value => value.subject.startsWith('issue:999:')));
    assert.ok(f.store.get('github_issue', 'foreign'), 'retained data is not deleted');
  } finally { await f.close(); }
});

test('existing PR notices resolve and can reopen without duplicating the comment record', () => {
  const { store, provider } = setup();
  try {
    const change = fixtureChange(77, { title: 'Unlinked work', body: '' });
    update(store, provider, [change]);
    const initial = store.all('github_comment').find(value => value.change_id === change.id)!;
    initial.state = 'delivered'; store.put('github_comment', initial.id, initial);
    for (const job of store.all('event_job')) { job.state = 'done'; store.put('event_job', job.id, job); }
    update(store, provider, [{ ...change, body: 'Task: #1' }]);
    assert.match(store.get('github_comment', initial.id)!.body, /notice — resolved/);
    for (const job of store.all('event_job')) { job.state = 'done'; store.put('event_job', job.id, job); }
    update(store, provider, [change]);
    assert.equal(store.all('github_comment').filter(value => value.change_id === change.id).length, 1);
    assert.equal(store.get('github_comment', initial.id)!.body, initial.body);
    assert.ok(store.all('event_job').some(job => job.type === 'github_comment' && job.state === 'queued' && JSON.parse(job.payload).comment_id === initial.id));
  } finally { store.close(); }
});
