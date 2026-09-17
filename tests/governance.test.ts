import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { config } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { FakeProvider, demoSha, fixtureChange, seedDemo } from '../src/server/demo.js';
import { applySnapshot } from '../src/server/coordinator.js';
import { GOVERNANCE_LABEL, parseAgentsReviewPr, preservesExistingPolicy } from '../src/server/governance.js';
import { OpenAIModelClient, StaticGovernanceModel, validateGovernanceModelOutput, type GovernanceModelOutput } from '../src/server/model.js';

const cfg = config({}, true);
const demoPolicy = '# FAKE demonstration policy\nRead directory policies in your checkout. No code is executed by the coordinator.';
const additivePolicy = (rule: string) => `${demoPolicy}\n${rule}\n`;

class CountingModel extends StaticGovernanceModel {
  calls = 0;
  override async review(input: string, requestId?: string): Promise<GovernanceModelOutput> {
    this.calls++;
    return super.review(input, requestId);
  }
}

function setup(output: GovernanceModelOutput) {
  const store = new Store(':memory:');
  const provider = new FakeProvider();
  seedDemo(store, cfg, provider);
  const change = fixtureChange(3, { state: 'merged', merge_sha: demoSha(303), title: 'FAKE merged change', body: '' });
  const issue = { ...provider.data.issues![0], id: '101:issue:3', number: 3, body: 'PR: #3', labels: [GOVERNANCE_LABEL], updated_at: Date.now() };
  provider.data.changes = [change];
  provider.data.branches = ['main'];
  provider.data.issues = [issue];
  provider.governancePermissions.set('contributor', { id: '2', login: 'contributor', permission: 'push', can_write: true });
  store.tx(() => applySnapshot(store, provider.data));
  const model = new CountingModel(output);
  return { store, provider, model };
}

function payload(provider: FakeProvider, delivery: string) {
  const issue = provider.data.issues![0];
  return { raw: JSON.stringify({ action: 'labeled', label: { name: GOVERNANCE_LABEL }, installation: { id: 201 }, repository: { id: 101 }, sender: { id: 2, login: 'contributor', type: 'User' }, issue: { id: issue.id, number: issue.number, body: issue.body, labels: [{ name: GOVERNANCE_LABEL }] } }), delivery };
}

async function send(app: any, value: { raw: string; delivery: string }) {
  return app.inject({ method: 'POST', url: '/webhooks/github', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': value.delivery, 'x-hub-signature-256': `sha256=${createHmac('sha256', cfg.webhookSecret).update(value.raw).digest('hex')}` }, payload: value.raw });
}

test('canonical governance trigger is strict and durable', () => {
  assert.equal(parseAgentsReviewPr('PR: #123'), 123);
  assert.equal(parseAgentsReviewPr('prefix\nPR: #123'), null);
  assert.equal(parseAgentsReviewPr('PR: owner/repo#123'), null);
  assert.equal(parseAgentsReviewPr(' PR: #123'), null);
  assert.equal(parseAgentsReviewPr('PR: #123\n'), null);
});


test('configured governance model uses the selected OpenAI-compatible base URL', async () => {
  let called = '';
  const http: typeof fetch = async (input, init) => {
    called = String(input);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-secret');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, 'glm-5.3-fp8');
    assert.equal(request.response_format.type, 'json_schema');
    assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
    return new Response(JSON.stringify({ model: 'glm-5.3-fp8', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'no_change', rationale: 'No rule change needed', proposed_agents_md_lines: [] }) } }] }));
  };
  const client = new OpenAIModelClient({ enabled: true, apiKey: 'fixture-secret', baseUrl: 'http://model.example/v1', model: 'glm-5.3-fp8', privateCodeOptIn: true, disableThinking: true }, http);
  assert.equal((await client.review('bounded fixture evidence')).decision, 'no_change');
  assert.equal(called, 'http://model.example/v1/chat/completions');
});


test('governance model accepts an upstream deployment alias while validating output', async () => {
  const http: typeof fetch = async () => new Response(JSON.stringify({ model: 'glm-5.2-fp8', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'no_change', rationale: 'Alias response', proposed_agents_md_lines: [] }) } }] }));
  const client = new OpenAIModelClient({ enabled: true, apiKey: 'fixture-secret', baseUrl: 'http://model.example/v1', model: 'glm-5.3-fp8', privateCodeOptIn: true }, http);
  assert.equal((await client.review('fixture evidence')).decision, 'no_change');
});


test('governance decision and proposal content cannot contradict each other', () => {
  assert.throws(() => validateGovernanceModelOutput({ decision: 'no_change', rationale: 'contradiction', proposed_agents_md: '# Unexpected' }), /invalid governance JSON/);
  assert.throws(() => validateGovernanceModelOutput({ decision: 'update_rules', rationale: 'missing proposal', proposed_agents_md: '' }), /invalid governance JSON/);
  assert.equal(validateGovernanceModelOutput({ decision: 'fix_code', rationale: 'fix implementation', proposed_agents_md: '' }).decision, 'fix_code');
});


test('automatic policy proposals preserve every existing rule verbatim and in order', () => {
  assert.equal(preservesExistingPolicy(demoPolicy, additivePolicy('New approved rule.')), true);
  assert.equal(preservesExistingPolicy(demoPolicy, '# FAKE demonstration policy\nNew rule only.'), false);
  assert.equal(preservesExistingPolicy(demoPolicy, 'Read directory policies in your checkout. No code is executed by the coordinator.\n# FAKE demonstration policy'), false);
});

async function drain(built: Awaited<ReturnType<typeof buildApp>>, fixture: ReturnType<typeof setup>) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pending = fixture.store.all('governance_request').some(request => request.state === 'queued');
    if (!pending) break;
    await built.worker.tick();
  }
}

test('signed labeled request reaches one offline proposal and duplicate delivery never charges the model twice', async () => {
  const output: GovernanceModelOutput = { decision: 'update_rules', rationale: 'FAKE rationale', proposed_agents_md: additivePolicy('Run focused checks.') };
  const fixture = setup(output);
  const built = await buildApp(cfg, fixture.store, fixture.provider, { worker: false, model: fixture.model });
  try {
    const first = await send(built.app, payload(fixture.provider, 'governance-1'));
    const duplicate = await send(built.app, payload(fixture.provider, 'governance-1'));
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().governance, true);
    assert.equal(duplicate.json().duplicate, true);
    for (let attempt = 0; attempt < 8 && fixture.store.get('governance_request', fixture.store.all('governance_request')[0].id)?.state === 'queued'; attempt++) await built.worker.tick();
    const requests = fixture.store.all('governance_request');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].state, 'proposal');
    assert.equal(requests[0].decision, 'update_rules');
    assert.equal(requests[0].proposal_number, 901);
    assert.equal(fixture.model.calls, 1);
    assert.equal(fixture.provider.governanceBranches.size, 1);
    assert.equal(fixture.provider.governancePullRequests.length, 1);
    assert.equal(fixture.provider.governanceComments.length, 1);
    assert.match(fixture.provider.governanceComments[0].body, /Human review and approval/);
    const visible = await built.app.inject({ url: '/api/governance', headers: { cookie: `kapo_session=${built.auth.session('1').token}` } });
    assert.equal(visible.statusCode, 200);
    assert.equal(visible.json().items[0].proposal_number, 901);
  } finally {
    await built.app.close();
    fixture.store.close();
  }
});

test('disabled governance records an honest not-configured result without a model call', async () => {
  const fixture = setup({ decision: 'no_change', rationale: 'should not run', proposed_agents_md: '' });
  const built = await buildApp(cfg, fixture.store, fixture.provider, { worker: false });
  try {
    const response = await send(built.app, payload(fixture.provider, 'governance-disabled'));
    assert.equal(response.statusCode, 202);
    for (let attempt = 0; attempt < 8 && fixture.store.get('governance_request', fixture.store.all('governance_request')[0].id)?.state === 'queued'; attempt++) await built.worker.tick();
    const request = fixture.store.all('governance_request')[0];
    assert.equal(request.state, 'not_configured');
    assert.equal(request.decision, null);
    assert.equal(request.proposal_number, null);
    assert.match(request.error ?? '', /not configured|disabled/i);
    assert.equal(fixture.provider.governanceBranches.size, 0);
    assert.match(fixture.provider.governanceComments[0].body, /Not configured/);
  } finally {
    await built.app.close();
    fixture.store.close();
  }
});

test('no-change and fix-code decisions finish without any policy write', async () => {
  for (const decision of ['no_change', 'fix_code'] as const) {
    const fixture = setup({ decision, rationale: `FAKE ${decision}`, proposed_agents_md: '' });
    const built = await buildApp(cfg, fixture.store, fixture.provider, { worker: false, model: fixture.model });
    try {
      assert.equal((await send(built.app, payload(fixture.provider, `governance-${decision.replace('_', '-')}`))).statusCode, 202);
      await drain(built, fixture);
      const request = fixture.store.all('governance_request')[0];
      assert.equal(request.state, 'result');
      assert.equal(request.decision, decision);
      assert.equal(request.proposal_number, null);
      assert.equal(fixture.provider.governanceBranches.size, 0);
    } finally {
      await built.app.close();
      fixture.store.close();
    }
  }
});

test('invalid output and current permission changes are fail-closed', async () => {
  const invalid = setup({ decision: 'not-a-decision', rationale: 'invalid', proposed_agents_md: '' } as unknown as GovernanceModelOutput);
  const invalidBuilt = await buildApp(cfg, invalid.store, invalid.provider, { worker: false, model: invalid.model });
  try {
    await send(invalidBuilt.app, payload(invalid.provider, 'governance-invalid'));
    await drain(invalidBuilt, invalid);
    const request = invalid.store.all('governance_request')[0];
    assert.equal(request.state, 'diagnostic');
    assert.equal(invalid.model.calls, 1);
    assert.equal(invalid.provider.governanceBranches.size, 0);
  } finally {
    await invalidBuilt.app.close();
    invalid.store.close();
  }

  const unauthorized = setup({ decision: 'update_rules', rationale: 'must not run', proposed_agents_md: '# no write\n' });
  unauthorized.provider.governancePermissions.set('contributor', { id: '2', login: 'contributor', permission: 'triage', can_write: false });
  const unauthorizedBuilt = await buildApp(cfg, unauthorized.store, unauthorized.provider, { worker: false, model: unauthorized.model });
  try {
    await send(unauthorizedBuilt.app, payload(unauthorized.provider, 'governance-unauthorized'));
    await drain(unauthorizedBuilt, unauthorized);
    const request = unauthorized.store.all('governance_request')[0];
    assert.equal(request.state, 'diagnostic');
    assert.equal(unauthorized.model.calls, 0);
    assert.equal(unauthorized.provider.governanceBranches.size, 0);
  } finally {
    await unauthorizedBuilt.app.close();
    unauthorized.store.close();
  }
});

test('stale model baseline and non-AGENTS diffs never create a draft PR', async () => {
  const stale = setup({ decision: 'update_rules', rationale: 'stale', proposed_agents_md: additivePolicy('Stale addition.') });
  const originalReview = stale.model.review.bind(stale.model);
  stale.model.review = async (input, requestId) => {
    const result = await originalReview(input, requestId);
    stale.provider.data.integration_sha = demoSha(999);
    return result;
  };
  const staleBuilt = await buildApp(cfg, stale.store, stale.provider, { worker: false, model: stale.model });
  try {
    await send(staleBuilt.app, payload(stale.provider, 'governance-stale'));
    await drain(staleBuilt, stale);
    assert.equal(stale.store.all('governance_request')[0].state, 'diagnostic');
    assert.equal(stale.provider.governanceBranches.size, 0);
    await send(staleBuilt.app, payload(stale.provider, 'governance-stale-retry'));
    await drain(staleBuilt, stale);
    const retried = stale.store.all('governance_request').find(value => value.delivery_id === 'governance-stale-retry');
    assert.equal(retried?.state, 'proposal');
    assert.equal(stale.model.calls, 2);
    assert.equal(stale.provider.governancePullRequests.length, 1);
  } finally {
    await staleBuilt.app.close();
    stale.store.close();
  }

  const mixed = setup({ decision: 'update_rules', rationale: 'mixed diff', proposed_agents_md: additivePolicy('Mixed addition.') });
  mixed.provider.governanceDiff = async () => ({ base_sha: demoSha(3), head_sha: demoSha(4), files: ['AGENTS.md', 'src/app.ts'], complete: true });
  const mixedBuilt = await buildApp(cfg, mixed.store, mixed.provider, { worker: false, model: mixed.model });
  try {
    await send(mixedBuilt.app, payload(mixed.provider, 'governance-mixed-diff'));
    await drain(mixedBuilt, mixed);
    assert.equal(mixed.store.all('governance_request')[0].state, 'diagnostic');
    assert.equal(mixed.provider.governancePullRequests.length, 0);
  } finally {
    await mixedBuilt.app.close();
    mixed.store.close();
  }
});


test('a crashed model attempt becomes a diagnostic and delivers the possible-charge warning', async () => {
  const fixture = setup({ decision: 'no_change', rationale: 'unused', proposed_agents_md: '' });
  const built = await buildApp(cfg, fixture.store, fixture.provider, { worker: false, model: fixture.model });
  try {
    assert.equal((await send(built.app, payload(fixture.provider, 'governance-crashed-attempt'))).statusCode, 202);
    const request = fixture.store.all('governance_request')[0];
    request.state = 'running'; request.model_attempts = 1; request.decision = null; fixture.store.put('governance_request', request.id, request);
    for (const queued of fixture.store.all('event_job')) {
      if (queued.type !== 'governance_review') { queued.state = 'done'; queued.lease_until = 0; fixture.store.put('event_job', queued.id, queued); }
    }
    const job = fixture.store.all('event_job').find(value => value.type === 'governance_review')!;
    job.next_at = 0; fixture.store.put('event_job', job.id, job);
    await built.worker.tick();
    const current = fixture.store.get('governance_request', request.id)!;
    assert.equal(current.state, 'diagnostic');
    assert.match(current.error ?? '', /previous model attempt may have been charged/);
    assert.match(fixture.provider.governanceComments[0].body, /possible charge/);
    assert.equal(fixture.model.calls, 0);
  } finally {
    await built.app.close();
    fixture.store.close();
  }
});


test('governance proposal requires matching branch content and App-authored proof', async () => {
  const fixture = setup({ decision: 'update_rules', rationale: 'tampered', proposed_agents_md: additivePolicy('Expected addition.') });
  const original = fixture.provider.governanceDiff.bind(fixture.provider);
  fixture.provider.governanceDiff = async (branch, base) => ({ ...(await original(branch, base)), policy_content: '# attacker\n', app_authored: false });
  const built = await buildApp(cfg, fixture.store, fixture.provider, { worker: false, model: fixture.model });
  try {
    assert.equal((await send(built.app, payload(fixture.provider, 'governance-tampered-branch'))).statusCode, 202);
    await drain(built, fixture);
    const request = fixture.store.all('governance_request')[0];
    assert.equal(request.state, 'diagnostic');
    assert.match(request.error ?? '', /App-authored|literal root/);
    assert.equal(fixture.provider.governancePullRequests.length, 0);
  } finally {
    await built.app.close();
    fixture.store.close();
  }
});
