import type { Change, ContextSnapshot, GitHubIssue, GovernanceBranch, GovernanceDiff, GovernanceEvidence, GovernanceIssue, GovernancePermission, GovernancePullRequestResult, Project, ProjectObservation, SyncSnapshot } from '../shared/types.js';
import { governanceMarker, ProviderError, type Provider, type UserCredentials } from './github.js';
import { Store } from './db.js';
import { encrypt } from './auth.js';
import type { Config } from './config.js';
import { applySnapshot } from './coordinator.js';

export const demoSha = (value: number) => value.toString(16).padStart(40, '0');

export function fixtureChange(number: number, patch: Partial<Change> = {}): Change {
  const identity = `101:pr:${number}`;
  const head = demoSha(number + 100);
  return { id: identity, identity, kind: 'pr', number, branch: `feature/demo-${number}`, head_sha: head, base_sha: demoSha(1), merge_sha: null, base_ref: 'main', state: 'open', draft: false, title: `FAKE demo change ${number}`, body: '', actor: '1', url: `https://example.invalid/FAKE/demo/pull/${number}`, commits: [{ sha: head, message: 'FAKE demonstration commit', actor: '1', url: 'https://example.invalid/FAKE/commit' }], files: ['src/example.ts'], complete: true, integrity: null, canonical_id: null, version: 1, observed_at: Date.now(), ...patch };
}

const fakeIssue = (number: number, patch: Partial<GitHubIssue> = {}): GitHubIssue => ({ id: `101:issue:${number}`, repo_id: '101', number, title: number === 1 ? 'FAKE task-first Issue' : 'FAKE Git-first Issue', body: number === 1 ? 'Acceptance criteria live in this GitHub-shaped Issue.' : 'Use GitHub Issue content for planning.', state: 'open', author: '1', assignees: ['1'], labels: ['demo'], url: `https://example.invalid/FAKE/demo/issues/${number}`, updated_at: Date.now(), closed_at: null, ...patch });

/** Injectable fake is never selected implicitly and never makes HTTP calls. */
export class FakeProvider implements Provider {
  readonly fake = true;
  access = true;
  failure: Error | null = null;
  governanceComments: { id: number; issue: number; body: string }[] = [];
  governanceReviews: { id: number; pull: number; body: string; event: 'APPROVE' | 'REQUEST_CHANGES' }[] = [];
  governanceBranches = new Map<string, { sha: string; baseSha: string; policySha: string; content: string }>();
  governancePullRequests: GovernancePullRequestResult[] = [];
  governancePermissions = new Map<string, GovernancePermission>();
  data: SyncSnapshot;

  constructor(changes: Change[] = [fixtureChange(1, { title: 'FAKE task-first implementation', body: 'Task: #1' }), fixtureChange(2, { title: 'FAKE Git-first change without Issue' })]) {
    const issues = [fakeIssue(1), fakeIssue(2)];
    const project: ProjectObservation = { node_id: 'PVT_demo', number: 1, title: 'FAKE vf-kapo Project', url: 'https://example.invalid/FAKE/project/1', status_field_id: 'PVTSSF_demo', status_field_name: 'Status', status_options: [{ id: 'todo', name: 'Todo' }, { id: 'progress', name: 'In progress' }, { id: 'done', name: 'Done' }], items: [{ id: 'PVTITEM_demo_1', project_node_id: 'PVT_demo', content_type: 'Issue', issue_id: 'gid://github/Issue/1', issue_number: 1, repo_id: '101', status: 'Todo', status_field_id: 'PVTSSF_demo', updated_at: Date.now() }], fetched_at: Date.now() };
    this.data = { changes, branches: ['main', ...changes.map(change => change.branch)], integration_sha: demoSha(1), default_branch: 'main', full_name: 'FAKE/demo', url: 'https://example.invalid/FAKE/demo', empty: false, gaps: ['FAKE DATA: this demo has no GitHub connection'], context: { sha: demoSha(1), fetched_at: Date.now(), documents: { 'AGENTS.md': { blob_sha: demoSha(2), content: '# FAKE demonstration policy\nRead directory policies in your checkout. No code is executed by the coordinator.', missing: false, truncated: false }, 'PROJECT.md': { blob_sha: demoSha(3), content: '# FAKE GitHub-shaped project', missing: false, truncated: false } }, inventory: [{ path: 'AGENTS.md', type: 'blob', sha: demoSha(2) }, { path: 'PROJECT.md', type: 'blob', sha: demoSha(3) }], manifests: [], scoped_policies: [], truncated: false, warnings: ['FAKE DATA only; this is not a complete repository inventory'] }, issues, project };
  }

  async exchange(): Promise<UserCredentials> { return { access_token: 'fake-only', refresh_token: 'fake-refresh', expires_at: Date.now() + 3_600_000 }; }
  async refresh() { return this.exchange(); }
  async user() { return { id: '1', login: 'Demo Developer (FAKE)' }; }
  async userAccess() { return this.access; }
  async repository() { return { id: '101', installation_id: '201', full_name: this.data.full_name, url: this.data.url, default_branch: this.data.default_branch, private: true, head_sha: this.data.integration_sha }; }
  async snapshot(_project: Project, _tracked: Change[]) { if (this.failure) throw this.failure; const data = structuredClone(this.data); for (const change of data.changes) change.observed_at = Date.now(); for (const issue of data.issues ?? []) issue.updated_at = Date.now(); if (data.project) data.project.fetched_at = Date.now(); return data; }


  async governanceIssue(number: number, allowPullRequest = false): Promise<GovernanceIssue> {
    if (this.failure) throw this.failure;
    if (allowPullRequest) {
      const change = this.data.changes.find(value => value.kind === 'pr' && value.number === number);
      if (!change) throw new ProviderError('FAKE governance PR not found', 404);
      return { id: `101:pr:${number}`, repo_id: '101', number, title: change.title, body: change.body, labels: ['kapo:review-change'], author_id: change.actor, author_login: 'Demo Contributor (FAKE)', updated_at: change.observed_at };
    }
    const issue = this.data.issues?.find(value => value.number === number);
    if (!issue) throw new ProviderError('FAKE governance Issue not found', 404);
    return { id: issue.id, repo_id: issue.repo_id, number: issue.number, title: issue.title, body: issue.body, labels: [...issue.labels], author_id: issue.author, author_login: issue.author === '1' ? 'Demo Developer (FAKE)' : null, updated_at: issue.updated_at };
  }

  async governancePermission(login: string): Promise<GovernancePermission> {
    if (this.failure) throw this.failure;
    const known = this.governancePermissions.get(login);
    if (known) return { ...known };
    if (login === 'Demo Developer (FAKE)') return { id: '1', login, permission: 'admin', can_write: true };
    if (login === 'Demo Contributor (FAKE)') return { id: '2', login, permission: 'push', can_write: true };
    // The fake intentionally permits a test-supplied collaborator name while
    // omitting an ID; real GitHub always supplies the immutable collaborator ID.
    return { id: null, login, permission: 'write', can_write: true };
  }

  async governanceBaseline(_project: Project) {
    if (this.failure) throw this.failure;
    const policy = this.data.context?.documents['AGENTS.md'];
    return { integration_sha: this.data.integration_sha!, policy_sha: policy && !policy.missing && !policy.truncated ? policy.blob_sha : null };
  }

  async governancePolicy(_project: Project): Promise<{ integration_sha: string; policy: GovernanceEvidence['policy'] }> {
    if (this.failure) throw this.failure;
    const policy = this.data.context?.documents['AGENTS.md'];
    if (!policy) throw new ProviderError('FAKE governance policy unavailable', 404);
    return { integration_sha: this.data.integration_sha!, policy: { sha: policy.blob_sha, content: policy.content, missing: policy.missing, truncated: policy.truncated } };
  }

  async governanceRepositoryContext(_project: Project, integrationSha: string): Promise<ContextSnapshot> {
    if (this.failure) throw this.failure;
    if (!this.data.context || this.data.integration_sha !== integrationSha) throw new ProviderError('FAKE repository context unavailable', 409);
    return { ...this.data.context, sha: integrationSha, codebase_complete: true };
  }

  async governanceEvidence(project: Project, number: number, expected: 'merged' | 'open' = 'merged'): Promise<GovernanceEvidence> {
    if (this.failure) throw this.failure;
    const change = this.data.changes.find(value => value.kind === 'pr' && value.number === number);
    const policy = this.data.context?.documents['AGENTS.md'];
    if (!change || !policy) throw new ProviderError('FAKE governance evidence unavailable', 404);
    const files = change.files.map(path => ({ path, status: 'modified', patch: `@@ FAKE patch for ${path} @@\n`, sha: null, omitted: false }));
    const pull = { id: `101:pr:${number}`, repo_id: '101', number, title: change.title, body: change.body, base_ref: change.base_ref, base_sha: change.base_sha, head_sha: change.head_sha, merge_sha: change.merge_sha, state: change.state, draft: change.draft, files, commits: structuredClone(change.commits) } as GovernanceEvidence['pull_request'];
    const warnings: string[] = [];
    if ((expected === 'merged' ? change.state !== 'merged' : change.state !== 'open') || change.base_ref !== project.integration_branch) warnings.push(`FAKE referenced PR is not a ${expected} PR targeting the integration branch`);
    if (policy.missing) warnings.push('FAKE root AGENTS.md is missing');
    return { repo_id: '101', integration_sha: this.data.integration_sha!, default_branch: this.data.default_branch, policy: { sha: policy.blob_sha, content: policy.content, missing: policy.missing, truncated: policy.truncated }, pull_request: pull, complete: !warnings.length && !!this.data.integration_sha && policy.content !== null && !policy.truncated, warnings };
  }

  async createGovernanceBranch(name: string, baseSha: string): Promise<GovernanceBranch> {
    if (this.failure) throw this.failure;
    const policy = this.data.context?.documents['AGENTS.md'];
    if (!policy || baseSha !== this.data.integration_sha) throw new ProviderError('FAKE governance baseline changed', 409);
    const old = this.governanceBranches.get(name);
    if (old) {
      if (old.baseSha !== baseSha) throw new ProviderError('FAKE branch collision', 409);
      return { name, sha: old.sha };
    }
    this.governanceBranches.set(name, { sha: baseSha, baseSha, policySha: policy.blob_sha, content: policy.content ?? '' });
    return { name, sha: baseSha };
  }

  async updateGovernancePolicy(branch: string, policySha: string, content: string): Promise<{ sha: string }> {
    if (this.failure) throw this.failure;
    const value = this.governanceBranches.get(branch);
    if (!value) throw new ProviderError('FAKE governance branch missing', 409);
    if (value.policySha !== policySha) {
      if (value.content === content) return { sha: value.sha };
      throw new ProviderError('FAKE governance policy baseline changed', 409);
    }
    if (value.content === content) return { sha: value.sha };
    value.content = content;
    value.sha = demoSha(10 + this.governanceBranches.size);
    return { sha: value.sha };
  }

  async governanceDiff(branch: string, baseSha: string): Promise<GovernanceDiff> {
    if (this.failure) throw this.failure;
    const value = this.governanceBranches.get(branch);
    if (!value || value.baseSha !== baseSha) return { base_sha: baseSha, head_sha: '', files: [], complete: false, policy_content: null, app_authored: false };
    return { base_sha: baseSha, head_sha: value.sha, files: ['AGENTS.md'], complete: true, policy_content: value.content, app_authored: true };
  }

  async createGovernancePullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<GovernancePullRequestResult> {
    if (this.failure) throw this.failure;
    const existing = this.governancePullRequests.find(value => value.head === input.branch && value.base === input.base);
    if (existing) return existing;
    const result = { id: `FAKE:governance:${this.governancePullRequests.length + 1}`, number: 900 + this.governancePullRequests.length + 1, url: `https://example.invalid/FAKE/demo/pull/${900 + this.governancePullRequests.length + 1}`, head: input.branch, base: input.base, draft: true };
    this.governancePullRequests.push(result);
    return result;
  }

  async maintainGovernanceComment(issueNumber: number, body: string): Promise<{ id: number; body: string }> {
    if (this.failure) throw this.failure;
    const existing = this.governanceComments.find(value => value.issue === issueNumber);
    if (existing) { existing.body = body; return { id: existing.id, body }; }
    const value = { id: 10_000 + this.governanceComments.length + 1, issue: issueNumber, body };
    this.governanceComments.push(value);
    return { id: value.id, body };
  }

  async maintainGovernanceReview(pullNumber: number, body: string, event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<{ id: number; body: string }> {
    if (this.failure) throw this.failure;
    const marker = body.match(/<!-- vf-kapo:main-review:[^>]+ -->/)?.[0];
    const existing = this.governanceReviews.find(value => marker && value.body.includes(marker));
    if (existing) return { id: existing.id, body: existing.body };
    const value = { id: 20_000 + this.governanceReviews.length + 1, pull: pullNumber, body, event };
    this.governanceReviews.push(value);
    return { id: value.id, body };
  }
}

export function seedDemo(store: Store, cfg: Config, provider: FakeProvider) {
  if (!cfg.demo || cfg.production) throw new Error('Demo seed forbidden');
  if (store.get('project', '1')) return;
  store.tx(() => {
    store.put('member', '1', { id: '1', login: 'Demo Developer (FAKE)', role: 'developer', active: true, access_checked: Date.now(), credentials: encrypt({ access_token: 'fake-only', expires_at: Date.now() + 3_600_000 }, cfg.encryptionKey) });
    store.put('member', '2', { id: '2', login: 'Demo Contributor (FAKE)', role: 'contributor', active: true, access_checked: Date.now(), credentials: encrypt({ access_token: 'fake-only', expires_at: Date.now() + 3_600_000 }, cfg.encryptionKey) });
    store.put('project', '1', { repo_id: '101', installation_id: '201', full_name: 'FAKE/demo', url: 'https://example.invalid/FAKE/demo', integration_branch: 'main', default_branch: 'main', prefix: cfg.prefix, sequence: 0, confirmed: true, init: 'ready', last_sync: Date.now(), checkpoint: demoSha(1), error: null, coverage_start: Date.now(), gaps: ['FAKE demonstration only'], source_of_truth: 'github', project_node_id: 'PVT_demo', project_status_field_id: 'PVTSSF_demo', project_status_field_name: 'Status', project_url: 'https://example.invalid/FAKE/project/1', legacy_data_warning: null });
    applySnapshot(store, provider.data);
  });
}
