import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { FakeProvider, demoSha, fixtureChange, seedDemo } from '../src/server/demo.js';
import { applySnapshot } from '../src/server/coordinator.js';

test('native context is read-only and never projects a legacy local task', async () => {
  const cfg = config({}, true);
  const store = new Store(':memory:');
  const provider = new FakeProvider();
  seedDemo(store, cfg, provider);
  const built = await buildApp(cfg, store, provider, { worker: false });
  const session = built.auth.session('1');
  try {
    const response = await built.app.inject({
      url: '/api/project/context?task=TASK-1',
      headers: { cookie: `kapo_session=${session.token}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.project.source_of_truth, 'github');
    assert.equal(body.task, null);
    assert.equal(body.issue, null);
    assert.equal(body.warning.includes('actual checkout'), true);
  } finally {
    await built.app.close();
    store.close();
  }
});


test('native Issue joins ignore Project items from a different configured node', async () => {
  const nativeCfg = { ...config({}, true), projectNodeId: 'PVT_current' };
  const store = new Store(':memory:');
  const provider = new FakeProvider();
  seedDemo(store, nativeCfg, provider);
  const built = await buildApp(nativeCfg, store, provider, { worker: false });
  const session = built.auth.session('1');
  try {
    const headers = { cookie: `kapo_session=${session.token}` };
    const list = await built.app.inject({ url: '/api/issues', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.find((issue: any) => issue.number === 1).project_item, null);
    const detail = await built.app.inject({ url: '/api/issues/1', headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().project_item, null);
  } finally {
    await built.app.close();
    store.close();
  }
});


test('native snapshot does not canonicalize retained legacy links or explanations', () => {
  const cfg = config({}, true);
  const store = new Store(':memory:');
  const provider = new FakeProvider();
  seedDemo(store, cfg, provider);
  const branch = fixtureChange(10, { id: 'legacy-branch', identity: 'legacy-branch', kind: 'branch', number: undefined, canonical_id: null });
  const pull = fixtureChange(11, { branch: branch.branch, commits: structuredClone(branch.commits), head_sha: branch.head_sha, canonical_id: null });
  const task: any = { id: 'legacy-task', key: 'TASK-10', title: 'retained', type: 'feature', description: '', owner: '1', criteria: [], paths: [], planning_status: 'backlog', status: 'backlog', suggested_status: 'backlog', sync_mode: 'manual', attention_kind: null, attention_reason: null, projection_reason: null, completion_pr_id: branch.id, archived: false, version: 1, created_at: Date.now(), updated_at: Date.now() };
  const link: any = { change_id: branch.id, task_id: task.id, state: 'confirmed', source: 'manual', actor: '1', evidence: ['retained'], revision: branch.head_sha, superseded_reason: null };
  const explanation: any = { id: 'legacy-explanation', change_id: branch.id, revision_sha: branch.head_sha, author: '1', agent: null, summary: 'retained', impact: 'retained', validation: { source: 'contributor_report', result: 'not_run', details: '' }, created_at: Date.now() };
  store.put('git_change', branch.id, branch); store.put('git_change', pull.id, pull); store.put('task', task.id, task); store.put('task_change', branch.id, link); store.put('explanation', explanation.id, explanation);
  const snapshot = structuredClone(provider.data); snapshot.changes = [branch, pull]; snapshot.branches = ['main', branch.branch];
  try {
    store.tx(() => applySnapshot(store, snapshot));
    assert.equal(store.get('git_change', branch.id)?.canonical_id, null);
    assert.deepEqual(store.get('task_change', branch.id), link);
    assert.equal(store.get('task', task.id)?.completion_pr_id, branch.id);
    assert.equal(store.get('explanation', explanation.id)?.change_id, branch.id);
  } finally { store.close(); }
});
