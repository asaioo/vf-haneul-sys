import { createHash, createSign } from 'node:crypto';
import type { Change, Commit, ContextSnapshot, GitHubIssue, GovernanceBranch, GovernanceDiff, GovernanceEvidence, GovernanceIssue, GovernancePermission, GovernancePullRequestResult, Project, ProjectItem, ProjectObservation, SyncSnapshot } from '../shared/types.js';
import type { Config } from './config.js';

export interface UserCredentials { access_token: string; refresh_token?: string; expires_at: number; refresh_expires_at?: number; }
export interface Provider {
  readonly fake: boolean;
  exchange(code: string): Promise<UserCredentials>;
  refresh(credentials: UserCredentials): Promise<UserCredentials>;
  user(credentials: UserCredentials): Promise<{ id: string; login: string }>;
  userAccess(credentials: UserCredentials, repoId: string): Promise<boolean>;
  repository(): Promise<{ id: string; installation_id: string; full_name: string; url: string; default_branch: string; private: boolean; head_sha: string | null }>;
  snapshot(project: Project, tracked: Change[], hints?: unknown): Promise<SyncSnapshot>;
  maintainComment?(change: Change, body: string): Promise<{ id: number; body: string }>;
  governanceIssue?(number: number, allowPullRequest?: boolean): Promise<GovernanceIssue>;
  governanceEvidence?(project: Project, number: number, expected?: 'merged' | 'open'): Promise<GovernanceEvidence>;
  governancePermission?(login: string): Promise<GovernancePermission>;
  governanceBaseline?(project: Project): Promise<{ integration_sha: string; policy_sha: string | null }>;
  governancePolicy?(project: Project): Promise<{ integration_sha: string; policy: GovernanceEvidence['policy'] }>;
  governanceRepositoryContext?(project: Project, integrationSha: string): Promise<ContextSnapshot>;
  createGovernanceBranch?(name: string, baseSha: string): Promise<GovernanceBranch>;
  updateGovernancePolicy?(branch: string, policySha: string, content: string): Promise<{ sha: string }>;
  governanceDiff?(branch: string, baseSha: string): Promise<GovernanceDiff>;
  createGovernancePullRequest?(input: { branch: string; base: string; title: string; body: string }): Promise<GovernancePullRequestResult>;
  maintainGovernanceComment?(issueNumber: number, body: string): Promise<{ id: number; body: string }>;
  maintainGovernanceReview?(pullNumber: number, body: string, event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<{ id: number; body: string }>;
}

export class ProviderError extends Error {
  constructor(message: string, public status = 502, public retryAt = 0) { super(message); }
}

export function appJwt(appId: string, key: string, now = Date.now()) {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}

type Json = Record<string, any>;
type PageOptions = { maxItems?: number; maxBytes?: number };
const sha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new ProviderError('Provider returned invalid SHA');
  return value;
};
const commit = (value: Json): Commit => ({ sha: sha(value.sha), message: String(value.commit?.message ?? ''), actor: value.author?.id ? String(value.author.id) : null, url: String(value.html_url ?? '') });
const issueId = (repoId: string, number: number) => `${repoId}:issue:${number}`;

async function boundedJson(response: Response, limit = 20 * 1024 * 1024): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new ProviderError('Provider response limit exceeded'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderError('Provider returned invalid JSON'); }
}

interface AppIdentity { id: string; login: string; }
interface ProviderComment { id: number; body: string; user?: { id?: number | string; login?: string; type?: string } }
const verifiedCommentAuthor = (user: ProviderComment['user'] | undefined, app: AppIdentity) => user?.type === 'Bot' && user.login === app.login;

export const coordinationMarker = (repoId: string, number: number) => `<!-- vf-kapo:coordination:${repoId}:${number} -->`;


export const governanceMarker = (repoId: string, number: number) => `<!-- vf-kapo:governance:${repoId}:${number} -->`;

/** Files that are not suitable for private-code model transmission. */
export function governancePathExcluded(path: string): boolean {
  const normalized = path.split(String.fromCharCode(92)).join('/');
  if (/(^|[/])(node_modules|dist|build|coverage|out|generated|vendor)([/]|$)/i.test(normalized)) return true;
  if (/(^|[/])(.env(?:[.].*)?|.*(?:secret|credential|token|password).*|.*[.](?:pem|key|p12|pfx|crt|cer|jks))$/i.test(normalized)) return true;
  return /[.](?:png|jpe?g|gif|webp|ico|pdf|zip|gz|bz2|7z|tar|wasm|exe|dll|so|dylib|class|jar|bin|db|sqlite|lock)$/i.test(normalized);
}

function repositoryContextPath(path: string): boolean {
  if (governancePathExcluded(path)) return false;
  const name = path.split('/').at(-1) ?? path;
  return /^(Dockerfile|Makefile|Procfile)$/i.test(name) || /[.](?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|kt|kts|md|mjs|cjs|php|proto|py|rb|rs|sh|sql|swift|toml|ts|tsx|vue|xml|ya?ml)$/i.test(name);
}

export function applicableScopedPolicies(paths: string[], inventory: Set<string>): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    for (let depth = 1; depth < parts.length; depth++) {
      const candidate = `${parts.slice(0, depth).join('/')}/AGENTS.md`;
      if (inventory.has(candidate)) found.add(candidate);
    }
  }
  return [...found].sort();
}

const governanceBranch = (name: string) => /^vf-kapo[/]agents-review-[A-Za-z0-9-]{8,120}$/.test(name);

export class GitHubProvider implements Provider {
  readonly fake = false;
  private installation?: { token: string; expires: number; proposal: boolean };
  private app?: AppIdentity;
  private cache = new Map<string, { etag: string; data: any }>();
  rateLimit: { remaining: string | null; reset: string | null } | null = null;

  constructor(private cfg: Config, private http: typeof fetch = fetch) {}

  private async request(path: string, token: string, method = 'GET', body?: unknown, conditional = false): Promise<{ data: any; headers: Headers }> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new ProviderError('Invalid provider path');
    const cached = conditional ? this.cache.get(path) : undefined;
    const response = await this.http(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'vf-kapo-github-native',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cached ? { 'If-None-Match': cached.etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    this.rateLimit = { remaining: response.headers.get('x-ratelimit-remaining'), reset: response.headers.get('x-ratelimit-reset') };
    if (response.status === 304 && cached) return { data: cached.data, headers: response.headers };
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const reset = response.headers.get('x-ratelimit-reset');
      const retryAt = retry ? Date.now() + Number(retry) * 1000 : response.status === 429 || response.status === 403 && this.rateLimit.remaining === '0' ? Math.max(Date.now() + 60_000, Number(reset) * 1000) : 0;
      throw new ProviderError(`GitHub request failed (${response.status})`, response.status, retryAt);
    }
    const data = await boundedJson(response);
    const etag = response.headers.get('etag');
    if (conditional && etag) {
      if (this.cache.size > 2_000) this.cache.clear();
      this.cache.set(path, { etag, data });
    }
    return { data, headers: response.headers };
  }

  /** Do not follow provider-supplied URLs; all REST pages stay on the fixed API host/path. */
  async pages(path: string, token: string, field?: string, options: PageOptions = {}): Promise<any[]> {
    const out: any[] = [];
    let expected: number | undefined;
    let bytes = 0;
    const identities = new Set<string>();
    // A full terminal page without a Link header needs one bounded empty-page
    // check, so the exact 10,000-record boundary remains valid.
    for (let page = 1; page <= 101; page++) {
      const { data, headers } = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
      const values = field ? data?.[field] : data;
      if (!Array.isArray(values)) throw new ProviderError('Invalid collection response');
      if (options.maxItems !== undefined && out.length + values.length > options.maxItems) throw new ProviderError('Collection exceeds bounded item limit; evidence incomplete');
      if (field && typeof data.total_commits === 'number') {
        if (expected !== undefined && expected !== data.total_commits) throw new ProviderError('Collection changed during pagination');
        expected = data.total_commits;
      }
      for (const value of values) {
        if (options.maxBytes !== undefined) {
          bytes += Buffer.byteLength(JSON.stringify(value) ?? '');
          if (bytes > options.maxBytes) throw new ProviderError('Collection exceeds bounded aggregate limit; evidence incomplete');
        }
        const identity = value?.filename ?? value?.sha ?? value?.id ?? value?.number ?? value?.name;
        if (identity !== undefined) {
          const key = String(identity);
          if (identities.has(key)) throw new ProviderError('Duplicate collection entries; pagination is not stable');
          identities.add(key);
        }
      }
      out.push(...values);
      if (out.length > 10_000) throw new ProviderError('Collection exceeds pilot limit; evidence incomplete');
      const next = /<[^>]+>;\s*rel="next"/.test(headers.get('link') ?? '');
      if (!next && values.length < 100) {
        if (expected !== undefined && out.length !== expected) throw new ProviderError('Incomplete paginated commit collection');
        return out;
      }
      // A full page without a Link is verified by fetching the next empty page.
    }
    throw new ProviderError('Pagination limit reached; evidence incomplete');
  }

  private async token(proposal = false) {
    if (this.installation && this.installation.proposal === proposal && this.installation.expires > Date.now() + 60_000) return this.installation.token;
    const { data } = await this.request(`/app/installations/${this.cfg.installationId}/access_tokens`, appJwt(this.cfg.appId, this.cfg.privateKey), 'POST', {
      repository_ids: [Number(this.cfg.repoId)],
      permissions: { contents: proposal ? 'write' : 'read', pull_requests: proposal ? 'write' : 'read', metadata: 'read', issues: proposal ? 'read' : 'write', organization_projects: 'read' },
    });
    if (!data?.token || !data?.expires_at) throw new ProviderError('Invalid installation token response');
    this.installation = { token: data.token, expires: Date.parse(data.expires_at), proposal };
    return data.token as string;
  }

  private async graphql(query: string, variables: Record<string, unknown>, token: string): Promise<any> {
    const response = await this.http('https://api.github.com/graphql', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vf-kapo-github-native', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    this.rateLimit = { remaining: response.headers.get('x-ratelimit-remaining'), reset: response.headers.get('x-ratelimit-reset') };
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      throw new ProviderError(`GitHub GraphQL request failed (${response.status})`, response.status, retry ? Date.now() + Number(retry) * 1000 : 0);
    }
    const body = await boundedJson(response, 5 * 1024 * 1024);
    if (!body || !Array.isArray(body.errors) && !body.data) throw new ProviderError('Invalid GitHub GraphQL response');
    if (Array.isArray(body.errors) && body.errors.length) throw new ProviderError(`GitHub Projects query failed: ${String(body.errors[0]?.message ?? 'GraphQL error')}`);
    if (!body.data) throw new ProviderError('GitHub Projects query returned no data');
    return body.data;
  }

  private async appIdentity(): Promise<AppIdentity> {
    if (this.app) return this.app;
    // GET /app authenticates the App itself, not an installation. An
    // installation token is valid for repository resources but is rejected by
    // this endpoint in live GitHub.
    const { data } = await this.request('/app', appJwt(this.cfg.appId, this.cfg.privateKey));
    if (!data?.id || !data?.slug) throw new ProviderError('GitHub App identity unavailable');
    this.app = { id: String(data.id), login: `${String(data.slug)}[bot]` };
    return this.app;
  }

  private async oauth(body: Record<string, string>) {
    const response = await this.http('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }) });
    if (!response.ok) throw new ProviderError('GitHub user authorization unavailable', 401);
    const data = await boundedJson(response, 64 * 1024) as Json;
    if (data?.error || !data?.access_token) throw new ProviderError('GitHub user authorization failed', 401);
    return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1_000 : Date.now() + 8 * 3_600_000, refresh_expires_at: data.refresh_token_expires_in ? Date.now() + Number(data.refresh_token_expires_in) * 1_000 : undefined };
  }

  exchange(code: string) { return this.oauth({ code, redirect_uri: `${this.cfg.origin}/auth/github/callback` }); }
  refresh(credentials: UserCredentials) {
    if (!credentials.refresh_token || credentials.refresh_expires_at && credentials.refresh_expires_at < Date.now()) throw new ProviderError('Reauthorization required', 401);
    return this.oauth({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
  }
  async user(credentials: UserCredentials) {
    const { data } = await this.request('/user', credentials.access_token);
    if (!data?.id) throw new ProviderError('Invalid GitHub user', 401);
    return { id: String(data.id), login: String(data.login) };
  }
  async userAccess(credentials: UserCredentials, repoId: string) {
    const { data } = await this.request(`/repositories/${repoId}`, credentials.access_token);
    return String(data?.id) === repoId && data?.private === true && data.permissions?.pull === true;
  }
  async repository() {
    const token = await this.token();
    const { data } = await this.request(`/repositories/${this.cfg.repoId}`, token);
    if (String(data?.id) !== this.cfg.repoId || !data.private || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(data.full_name))) throw new ProviderError('Configured private repository identity mismatch', 403);
    let headSha: string | null = null;
    try { const { data: branch } = await this.request(`/repos/${data.full_name}/branches/${encodeURIComponent(data.default_branch)}`, token); headSha = sha(branch.commit.sha); } catch (error) { if (!(error instanceof ProviderError && error.status === 404)) throw error; }
    return { id: String(data.id), installation_id: this.cfg.installationId, full_name: String(data.full_name), url: String(data.html_url), default_branch: String(data.default_branch), private: true, head_sha: headSha };
  }

  private async pr(number: number, root: string, token: string): Promise<Change> {
    const { data: pull } = await this.request(`${root}/pulls/${number}`, token, 'GET', undefined, true);
    if (String(pull.base?.repo?.id) !== this.cfg.repoId || String(pull.head?.repo?.id) !== this.cfg.repoId) throw new ProviderError('External/fork PR is outside private-team scope');
    const commits = (await this.pages(`${root}/pulls/${number}/commits`, token)).map(commit);
    const files = await this.pages(`${root}/pulls/${number}/files`, token);
    const { data: verify } = await this.request(`${root}/pulls/${number}`, token);
    if (verify.head.sha !== pull.head.sha || verify.updated_at !== pull.updated_at || verify.state !== pull.state || verify.base.sha !== pull.base.sha) throw new ProviderError('PR changed during collection; retry');
    if (commits.length !== pull.commits || files.length !== pull.changed_files) throw new ProviderError('PR commits/files truncated by provider; cannot project completion');
    const identity = `${this.cfg.repoId}:pr:${number}`;
    return { id: identity, identity, kind: 'pr', number, branch: String(pull.head.ref), head_sha: sha(pull.head.sha), base_sha: sha(pull.base.sha), merge_sha: pull.merge_commit_sha ? sha(pull.merge_commit_sha) : null, base_ref: String(pull.base.ref), state: pull.merged ? 'merged' : pull.state, draft: !!pull.draft, title: String(pull.title), body: String(pull.body ?? ''), actor: pull.user?.id ? String(pull.user.id) : null, url: String(pull.html_url), commits, files: files.map(file => String(file.filename)), complete: true, integrity: null, canonical_id: null, version: 1, observed_at: Date.now() };
  }

  private async issues(root: string, token: string): Promise<GitHubIssue[]> {
    const values = await this.pages(`${root}/issues?state=all&sort=updated&direction=desc`, token);
    const issues: GitHubIssue[] = [];
    for (const value of values as Json[]) {
      // REST /issues includes pull requests. A PR is Git evidence, never an Issue task.
      if (value.pull_request) continue;
      const number = Number(value.number);
      if (!Number.isSafeInteger(number) || number < 1) throw new ProviderError('GitHub returned invalid Issue number');
      if (value.repository?.id !== undefined && String(value.repository.id) !== this.cfg.repoId) throw new ProviderError('GitHub Issue belongs to an unexpected repository');
      const updated = Date.parse(String(value.updated_at));
      const closed = value.closed_at ? Date.parse(String(value.closed_at)) : NaN;
      if (!Number.isFinite(updated)) throw new ProviderError('GitHub returned invalid Issue timestamp');
      issues.push({ id: issueId(this.cfg.repoId, number), repo_id: this.cfg.repoId, number, title: String(value.title ?? ''), body: String(value.body ?? ''), state: value.state === 'closed' ? 'closed' : 'open', author: value.user?.id ? String(value.user.id) : null, assignees: Array.isArray(value.assignees) ? value.assignees.filter((assignee: Json) => assignee?.id).map((assignee: Json) => String(assignee.id)) : [], labels: Array.isArray(value.labels) ? value.labels.map((label: Json) => String(label.name ?? label)) : [], url: String(value.html_url ?? ''), updated_at: updated, closed_at: Number.isFinite(closed) ? closed : null });
    }
    return issues;
  }

  private async project(nodeId: string, token: string): Promise<ProjectObservation> {
    // Both collections are paged independently, but every page revalidates the
    // node/type/status field. Any GraphQL error or null page fails the whole
    // observation so the worker preserves the last valid cache.
    const query = `query($nodeId:ID!,$fieldCursor:String,$itemCursor:String){node(id:$nodeId){__typename ... on ProjectV2{id number title url fields(first:100,after:$fieldCursor){nodes{__typename ... on ProjectV2SingleSelectField{id name options{id name}}}pageInfo{hasNextPage endCursor}} items(first:100,after:$itemCursor){nodes{id content{__typename ... on Issue{id number repository{databaseId}} ... on PullRequest{id number repository{databaseId}} ... on DraftIssue{id title}} fieldValues(first:100){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{id name}}}}} } pageInfo{hasNextPage endCursor}}}}}`;
    let fieldDone = false;
    let itemDone = false;
    let fieldCursor: string | null = null;
    let itemCursor: string | null = null;
    const fieldCursors = new Set<string>();
    const itemCursors = new Set<string>();
    let node: any;
    let statusField: any;
    const rawItems: Json[] = [];
    const itemIds = new Set<string>();
    let pages = 0;
    const validPage = (info: any) => info && typeof info.hasNextPage === 'boolean' && (info.endCursor === null || typeof info.endCursor === 'string') && (!info.hasNextPage || typeof info.endCursor === 'string' && info.endCursor.length > 0);
    while (!fieldDone || !itemDone) {
      if (++pages > 100) throw new ProviderError('GitHub Project pagination exceeds pilot page limit; evidence incomplete');
      const data = await this.graphql(query, { nodeId, fieldCursor: fieldDone ? null : fieldCursor, itemCursor: itemDone ? null : itemCursor }, token);
      const current = data?.node;
      if (!current || current.id !== nodeId) throw new ProviderError('Configured GitHub Project was not found or is inaccessible', 403);
      if (current.__typename !== 'ProjectV2') throw new ProviderError('Configured GitHub node is not a Projects v2 project');
      node = current;
      const fields = current.fields?.nodes;
      if (!Array.isArray(fields) || fields.some((field: Json) => !field || typeof field.__typename !== 'string') || !validPage(current.fields?.pageInfo)) throw new ProviderError('GitHub Project status field collection is incomplete');
      const statusFields = fields.filter((field: Json) => field?.__typename === 'ProjectV2SingleSelectField' && field.name === 'Status');
      if (statusFields.length > 1 || statusField && statusFields.some((field: Json) => String(field.id) !== String(statusField.id))) throw new ProviderError('GitHub Project has multiple Status fields');
      statusField ??= statusFields[0];
      if (!statusField && !current.fields.pageInfo.hasNextPage) throw new ProviderError('GitHub Project has no Status field');
      const pageItems = current.items?.nodes;
      if (!Array.isArray(pageItems) || !validPage(current.items?.pageInfo)) throw new ProviderError('GitHub Project item collection is incomplete');
      // If fields have more pages than items (or vice versa), the completed
      // collection is returned again with a null cursor. Never duplicate it.
      if (!itemDone) for (const item of pageItems) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) throw new ProviderError('GitHub Project returned an invalid item');
        const id = item.id;
        if (itemIds.has(id)) throw new ProviderError('GitHub Project item pagination repeated an item');
        const content = item.content;
        if (!content || typeof content !== 'object') throw new ProviderError('GitHub Project returned an incomplete item content');
        const type = content.__typename;
        if (type !== 'Issue' && type !== 'PullRequest' && type !== 'DraftIssue' || typeof content.id !== 'string' || !content.id) throw new ProviderError('GitHub Project returned an invalid item content');
        if ((type === 'Issue' || type === 'PullRequest') && (!Number.isSafeInteger(content.number) || content.number < 1 || !Number.isSafeInteger(content.repository?.databaseId) || content.repository.databaseId < 1)) throw new ProviderError('GitHub Project returned incomplete repository item content');
        if (type === 'DraftIssue' && typeof content.title !== 'string') throw new ProviderError('GitHub Project returned incomplete draft item content');
        if (!item.fieldValues || !Array.isArray(item.fieldValues.nodes) || item.fieldValues.nodes.some((value: Json) => !value || typeof value !== 'object' || typeof value.__typename !== 'string')) throw new ProviderError('GitHub Project returned incomplete item field values');
        itemIds.add(id); rawItems.push(item);
      }
      if (!fieldDone) {
        const next = current.fields.pageInfo.hasNextPage ? current.fields.pageInfo.endCursor as string : null;
        if (next && fieldCursors.has(next)) throw new ProviderError('GitHub Project field pagination repeated a cursor');
        if (next) fieldCursors.add(next);
        fieldCursor = next; fieldDone = next === null;
      }
      if (!itemDone) {
        const next = current.items.pageInfo.hasNextPage ? current.items.pageInfo.endCursor as string : null;
        if (next && itemCursors.has(next)) throw new ProviderError('GitHub Project item pagination repeated a cursor');
        if (next) itemCursors.add(next);
        itemCursor = next; itemDone = next === null;
      }
      if (rawItems.length > 10_000) throw new ProviderError('GitHub Project item collection exceeds pilot limit');
    }
    if (!statusField?.id || statusField.name !== 'Status') throw new ProviderError('GitHub Project has no Status field');
    const items: ProjectItem[] = rawItems.flatMap((item: Json) => {
      const content = item.content;
      const type = content.__typename as ProjectItem['content_type'];
      const repoId = content.repository?.databaseId == null ? null : String(content.repository.databaseId);
      if (repoId !== this.cfg.repoId) return [];
      const values = item.fieldValues.nodes as Json[];
      const statusValue = values.find((value: Json) => value.field?.id === statusField.id) ?? values.find((value: Json) => value.field?.name === 'Status');
      return [{ id: item.id, project_node_id: nodeId, content_type: type, issue_id: type === 'Issue' ? String(content.id) : null, issue_number: type === 'Issue' || type === 'PullRequest' ? Number(content.number) : null, repo_id: repoId, status: statusValue?.name == null ? null : String(statusValue.name), status_field_id: String(statusField.id), updated_at: Date.now() }];
    });
    return { node_id: nodeId, number: node.number == null ? null : Number(node.number), title: String(node.title ?? ''), url: String(node.url ?? ''), status_field_id: String(statusField.id), status_field_name: String(statusField.name), status_options: Array.isArray(statusField.options) ? statusField.options.filter((option: Json) => option?.id && option?.name != null).map((option: Json) => ({ id: String(option.id), name: String(option.name) })) : [], items, fetched_at: Date.now() };
  }

  private async context(root: string, head: string, token: string, fullCodebase = false): Promise<ContextSnapshot> {
    const { data: tree } = await this.request(`${root}/git/trees/${head}?recursive=1`, token, 'GET', undefined, true);
    if (!Array.isArray(tree?.tree)) throw new ProviderError('Invalid tree response');
    const inventory = tree.tree.slice(0, 10_000).map((value: Json) => ({ path: String(value.path), type: String(value.type), sha: String(value.sha) }));
    const snapshot: ContextSnapshot = { sha: head, fetched_at: Date.now(), codebase_complete: false, documents: {}, inventory, manifests: inventory.filter((value: { path: string }) => /(^|\/)(package.json|Cargo.toml|go.mod|pyproject.toml|pom.xml|Gemfile)$/.test(value.path)).map((value: { path: string }) => value.path), scoped_policies: inventory.filter((value: { path: string }) => value.path.endsWith('/AGENTS.md')).map((value: { path: string }) => value.path), truncated: !!tree.truncated || tree.tree.length > 10_000, warnings: [] };
    const roots = ['AGENTS.md', 'PROJECT.md', 'ARCHITECTURE.md', 'DOMAIN.md'];
    const sourcePaths = fullCodebase ? inventory.filter((entry: { path: string; type: string }) => entry.type === 'blob' && repositoryContextPath(entry.path)).map((entry: { path: string }) => entry.path) : [];
    const paths = [...new Set([...roots, ...snapshot.manifests, ...snapshot.scoped_policies, ...sourcePaths])];
    const pathLimit = fullCodebase ? 300 : 100;
    if (paths.length > pathLimit) { snapshot.truncated = true; snapshot.warnings.push('Repository has too many context files for the bounded codebase snapshot'); }
    let aggregate = 0;
    for (const name of paths.slice(0, pathLimit)) {
      try {
        const encoded = name.split('/').map(encodeURIComponent).join('/');
        const { data } = await this.request(`${root}/contents/${encoded}?ref=${head}`, token, 'GET', undefined, true);
        if (data.type !== 'file') throw new ProviderError('Context path is not a regular file');
        const tooBig = data.size > 256 * 1024;
        let content: string | null = null;
        if (!tooBig) {
          if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new ProviderError('Context content unavailable');
          const bytes = Buffer.from(data.content, 'base64');
          if (bytes.length !== data.size) throw new ProviderError('Incomplete context document');
          if (aggregate + bytes.length > 1024 * 1024) { snapshot.truncated = true; snapshot.warnings.push('Repository context exceeds 1 MiB; remaining content is omitted'); continue; }
          aggregate += bytes.length;
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        snapshot.documents[name] = { blob_sha: sha(data.sha), content, missing: false, truncated: tooBig };
        if (tooBig) { snapshot.truncated = true; snapshot.warnings.push(`${name} exceeds 256 KiB; body omitted`); }
      } catch (error) {
        if (roots.includes(name) && error instanceof ProviderError && error.status === 404) { snapshot.documents[name] = { blob_sha: '', content: null, missing: true, truncated: false }; if (name === 'AGENTS.md') snapshot.warnings.push('Root AGENTS.md is missing'); }
        else throw error;
      }
    }
    snapshot.codebase_complete = fullCodebase && !snapshot.truncated;
    if (snapshot.truncated) snapshot.warnings.push('Repository inventory is truncated');
    return snapshot;
  }

  async snapshot(project: Project, tracked: Change[], hints?: unknown): Promise<SyncSnapshot> {
    const token = await this.token();
    const repo = await this.repository();
    const root = `/repos/${repo.full_name.split('/').map(encodeURIComponent).join('/')}`;
    let issues: GitHubIssue[] | undefined;
    let projectObservation: ProjectObservation | null | undefined;
    if (this.cfg.projectNodeId) {
      issues = await this.issues(root, token);
      projectObservation = await this.project(this.cfg.projectNodeId, token);
    }
    const branches = await this.pages(`${root}/branches`, token);
    if (!branches.length) return { changes: [], branches: [], context: null, integration_sha: null, default_branch: repo.default_branch, full_name: repo.full_name, url: repo.url, empty: true, gaps: [], issues, project: projectObservation };
    const baseBranch = branches.find(branch => branch.name === project.integration_branch);
    if (!baseBranch) throw new ProviderError('Configured integration branch is unavailable');
    const head = sha(baseBranch.commit.sha);
    const changes: Change[] = [];
    const gaps: string[] = [];
    const open = await this.pages(`${root}/pulls?state=open&sort=updated&direction=desc`, token);
    const numbers = new Set<number>([...open.map(value => value.number), ...tracked.filter(value => value.kind === 'pr').map(value => value.number!)].filter(Number.isSafeInteger));
    // Overlap checkpoint by ten minutes. Stop only after a complete page older than window.
    if (project.last_sync || project.coverage_start) {
      const cutoff = new Date(project.last_sync ? project.last_sync - 600_000 : project.coverage_start).toISOString();
      let finished = false;
      for (let page = 1; page <= 100; page++) {
        const { data } = await this.request(`${root}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, token);
        if (!Array.isArray(data)) throw new ProviderError('Invalid closed PR collection');
        for (const value of data) if (value.updated_at >= cutoff) numbers.add(value.number);
        if (data.length < 100 || data.some((value: Json) => value.updated_at < cutoff)) { finished = true; break; }
      }
      if (!finished) throw new ProviderError('Closed PR recovery pagination incomplete');
    }
    const hint = hints as Json | undefined;
    if (hint?.pull_request?.number && Number.isSafeInteger(hint.pull_request.number)) numbers.add(hint.pull_request.number);
    if (project.checkpoint && project.checkpoint !== head) {
      const comparePath = `${root}/compare/${project.checkpoint}...${head}`;
      const { data: comparison } = await this.request(`${comparePath}?per_page=100&page=1`, token);
      if (comparison.status === 'diverged' || comparison.status === 'behind') throw new ProviderError('Integration history rewritten; coverage gap requires admin review');
      const direct = await this.pages(comparePath, token, 'commits');
      for (const raw of direct) {
        const current = commit(raw);
        const prs = await this.pages(`${root}/commits/${current.sha}/pulls`, token);
        const relevant = prs.filter((value: Json) => String(value.base?.repo?.id) === project.repo_id && value.merged_at && value.base.ref === project.integration_branch);
        if (relevant.length) { for (const value of relevant) numbers.add(value.number); continue; }
        const identity = `${project.repo_id}:direct:${current.sha}`;
        const actor = hint?.ref === `refs/heads/${project.integration_branch}` && hint.after === current.sha && hint.sender?.id ? String(hint.sender.id) : null;
        const files = await this.pages(`${root}/commits/${current.sha}`, token, 'files');
        changes.push({ id: identity, identity, kind: 'direct_commit', branch: project.integration_branch, head_sha: current.sha, base_sha: project.checkpoint, merge_sha: null, base_ref: project.integration_branch, state: 'merged', draft: false, title: current.message, body: '', actor, url: current.url, commits: [current], files: files.map(file => String(file.filename)), complete: files.length < 3_000, integrity: files.length >= 3_000 ? 'Commit file collection reached provider limit' : null, canonical_id: null, version: 1, observed_at: Date.now() });
      }
    }
    for (const number of numbers) {
      try { changes.push(await this.pr(number, root, token)); }
      catch (error) {
        if (error instanceof ProviderError && error.retryAt) throw error;
        const old = tracked.find(value => value.kind === 'pr' && value.number === number);
        if (!old) throw error;
        changes.push({ ...old, complete: false, integrity: 'Canonical PR refresh failed; last known evidence preserved' });
      }
    }
    for (const branch of branches.filter(value => value.name !== project.integration_branch)) {
      const branchHead = sha(branch.commit.sha);
      const commits = (await this.pages(`${root}/compare/${head}...${branchHead}`, token, 'commits')).map(commit);
      if (!commits.length && !tracked.some(value => value.kind === 'branch' && value.branch === branch.name && !value.canonical_id && value.state !== 'deleted')) continue;
      if (changes.some(value => value.kind === 'pr' && value.branch === branch.name && value.head_sha === branchHead && value.complete)) continue;
      const existing = tracked.find(value => value.kind === 'branch' && value.branch === branch.name && value.head_sha === branchHead && value.state !== 'deleted' && !value.canonical_id);
      const identity = `${project.repo_id}:branch:${branch.name}`;
      const actor = hint?.ref === `refs/heads/${branch.name}` && hint.after === branchHead && hint.sender?.id ? String(hint.sender.id) : existing?.actor ?? null;
      const { data: comparison } = await this.request(`${root}/compare/${head}...${branchHead}?per_page=100&page=1`, token);
      if (!Array.isArray(comparison.files)) throw new ProviderError('Branch file evidence unavailable');
      const files = comparison.files.map((file: Json) => String(file.filename));
      changes.push({ id: existing?.id ?? identity, identity: existing?.identity ?? identity, kind: 'branch', branch: branch.name, incarnation: existing?.incarnation, head_sha: branchHead, base_sha: head, merge_sha: null, base_ref: project.integration_branch, state: 'open', draft: false, title: '', body: '', actor, url: `${repo.url}/tree/${encodeURIComponent(branch.name)}`, commits, files, complete: files.length < 300, integrity: files.length >= 300 ? 'Branch file collection reached provider limit; use a PR for complete evidence' : null, canonical_id: null, version: 1, observed_at: Date.now() });
    }
    for (const old of tracked.filter(value => value.kind === 'direct_commit' && !changes.some(change => change.id === value.id))) changes.push({ ...old, observed_at: Date.now() });
    const { data: verify } = await this.request(`${root}/branches/${encodeURIComponent(project.integration_branch)}`, token);
    if (verify.commit.sha !== head) throw new ProviderError('Integration branch moved during synchronization');
    const verifyBranches = await this.pages(`${root}/branches`, token);
    const fingerprint = (values: any[]) => values.map(value => `${value.name}:${value.commit.sha}`).sort().join('|');
    if (fingerprint(branches) !== fingerprint(verifyBranches)) throw new ProviderError('Branch inventory changed during collection');
    const verifyOpen = await this.pages(`${root}/pulls?state=open&sort=updated&direction=desc`, token);
    if (open.map(value => `${value.number}:${value.head.sha}`).sort().join('|') !== verifyOpen.map(value => `${value.number}:${value.head.sha}`).sort().join('|')) throw new ProviderError('Open PR inventory changed during collection');
    if (project.last_sync && Date.now() - project.last_sync > 600_000) gaps.push(`Recovery after ${new Date(project.last_sync).toISOString()}: ephemeral deleted branches/force-pushed commits may be unavailable`);
    return { changes, branches: branches.map(value => String(value.name)), context: await this.context(root, head, token), integration_sha: head, default_branch: repo.default_branch, full_name: repo.full_name, url: repo.url, empty: false, gaps, issues, project: projectObservation };
  }

  /** Maintain exactly one marked comment on a PR; never edit an unverified marker. */
  async maintainComment(change: Change, body: string): Promise<{ id: number; body: string }> {
    if (change.kind !== 'pr' || !change.number) throw new ProviderError('Coordination comments require a pull request');
    const token = await this.token();
    const app = await this.appIdentity();
    const repo = await this.repository();
    const root = `/repos/${repo.full_name.split('/').map(encodeURIComponent).join('/')}`;
    const comments = await this.pages(`${root}/issues/${change.number}/comments`, token) as ProviderComment[];
    const marker = coordinationMarker(this.cfg.repoId, change.number);
    const marked = comments.filter(comment => typeof comment.body === 'string' && comment.body.includes(marker));
    const verified = marked.filter(comment => verifiedCommentAuthor(comment.user, app));
    if (marked.length !== verified.length) throw new ProviderError('A coordination marker belongs to an unverified human; refusing to edit or duplicate it', 409);
    const existing = verified[0];
    if (existing) {
      if (existing.body === body) return { id: existing.id, body: existing.body };
      const { data } = await this.request(`${root}/issues/comments/${existing.id}`, token, 'PATCH', { body });
      if (!data?.id || typeof data.body !== 'string' || !data.body.includes(marker) || !verifiedCommentAuthor(data.user, app)) throw new ProviderError('GitHub comment update was not verified');
      return { id: Number(data.id), body: String(data.body) };
    }
    const { data } = await this.request(`${root}/issues/${change.number}/comments`, token, 'POST', { body });
    if (!data?.id || typeof data.body !== 'string' || !data.body.includes(marker) || !verifiedCommentAuthor(data.user, app)) throw new ProviderError('GitHub comment creation was not verified');
    return { id: Number(data.id), body: String(data.body) };
  }


  private async governanceRepository() {
    const repo = await this.repository();
    if (String(repo.id) !== this.cfg.repoId || String(repo.installation_id) !== this.cfg.installationId || !/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/.test(repo.full_name)) throw new ProviderError('Governance repository identity mismatch', 403);
    return { repo, root: `/repos/${repo.full_name.split('/').map(encodeURIComponent).join('/')}` };
  }

  private async governanceBase(project: Project) {
    if (project.repo_id !== this.cfg.repoId || project.installation_id !== this.cfg.installationId) throw new ProviderError('Governance project identity mismatch', 403);
    const token = await this.token();
    const { repo, root } = await this.governanceRepository();
    if (repo.default_branch !== project.integration_branch) throw new ProviderError('Integration branch is not the current default branch', 409);
    const { data: branch } = await this.request(`${root}/branches/${encodeURIComponent(project.integration_branch)}`, token);
    const integrationSha = sha(branch?.commit?.sha);
    let policy: { sha: string; content: string | null; missing: boolean; truncated: boolean };
    try {
      const { data } = await this.request(`${root}/contents/AGENTS.md?ref=${encodeURIComponent(integrationSha)}`, token);
      if (data?.type !== 'file') throw new ProviderError('Root AGENTS.md is not a regular file', 409);
      const size = Number(data.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) policy = { sha: sha(data.sha), content: null, missing: false, truncated: true };
      else {
        if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new ProviderError('Root AGENTS.md content is incomplete', 409);
        const bytes = Buffer.from(data.content, 'base64');
        if (bytes.length !== size || bytes.length > 1024 * 1024) throw new ProviderError('Root AGENTS.md content is incomplete', 409);
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new ProviderError('Root AGENTS.md content is not valid UTF-8', 409); }
        policy = { sha: sha(data.sha), content, missing: false, truncated: false };
      }
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) policy = { sha: '', content: null, missing: true, truncated: false };
      else throw error;
    }
    return { token, repo, root, integrationSha, policy };
  }

  async governanceIssue(number: number, allowPullRequest = false): Promise<GovernanceIssue> {
    if (!Number.isSafeInteger(number) || number < 1) throw new ProviderError('Invalid governance Issue number', 422);
    const token = await this.token();
    const { root } = await this.governanceRepository();
    const { data } = await this.request(`${root}/issues/${number}`, token, 'GET');
    const responseRepoId = data?.repository?.id ?? data?.repository_id;
    const responseRepoUrl = data?.repository_url;
    if (!!data?.pull_request !== allowPullRequest || !data?.id || responseRepoId != null && String(responseRepoId) !== this.cfg.repoId || responseRepoUrl != null && String(responseRepoUrl) !== `https://api.github.com${root}`) throw new ProviderError('Governance subject belongs to an unexpected repository or has the wrong type', 409);
    const updated = Date.parse(String(data.updated_at));
    if (!Number.isFinite(updated)) throw new ProviderError('Governance Issue has an invalid timestamp', 409);
    return { id: String(data.id), repo_id: this.cfg.repoId, number, title: String(data.title ?? ''), body: String(data.body ?? ''), labels: Array.isArray(data.labels) ? data.labels.map((label: Json) => String(label?.name ?? '')).filter(Boolean) : [], author_id: data.user?.id == null ? null : String(data.user.id), author_login: data.user?.login == null ? null : String(data.user.login), updated_at: updated };
  }

  async governancePermission(login: string): Promise<GovernancePermission> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) throw new ProviderError('Invalid governance requester login', 422);
    const token = await this.token();
    const { root } = await this.governanceRepository();
    try {
      const { data } = await this.request(`${root}/collaborators/${encodeURIComponent(login)}/permission`, token, 'GET');
      const permission = String(data?.permission ?? 'none').toLowerCase();
      return { id: data?.user?.id == null ? null : String(data.user.id), login: String(data?.user?.login ?? login), permission, can_write: ['push', 'maintain', 'admin', 'write'].includes(permission) };
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return { id: null, login, permission: 'none', can_write: false };
      throw error;
    }
  }

  async governanceBaseline(project: Project): Promise<{ integration_sha: string; policy_sha: string | null }> {
    const base = await this.governanceBase(project);
    return { integration_sha: base.integrationSha, policy_sha: base.policy.missing || base.policy.truncated ? null : base.policy.sha };
  }

  async governancePolicy(project: Project): Promise<{ integration_sha: string; policy: GovernanceEvidence['policy'] }> {
    const base = await this.governanceBase(project);
    return { integration_sha: base.integrationSha, policy: base.policy };
  }

  async governanceRepositoryContext(project: Project, integrationSha: string): Promise<ContextSnapshot> {
    const base = await this.governanceBase(project);
    if (base.integrationSha !== integrationSha) throw new ProviderError('Integration branch moved before repository context collection', 409);
    return this.context(base.root, integrationSha, base.token, true);
  }

  async governanceEvidence(project: Project, number: number, expected: 'merged' | 'open' = 'merged'): Promise<GovernanceEvidence> {
    const base = await this.governanceBase(project);
    const { data: pull } = await this.request(`${base.root}/pulls/${number}`, base.token, 'GET');
    const warnings: string[] = [];
    let complete = true;
    if (!pull?.id || Number(pull.number) !== number) throw new ProviderError('Governance PR identity mismatch', 409);
    if (String(pull.base?.repo?.id) !== this.cfg.repoId || String(pull.head?.repo?.id) !== this.cfg.repoId) throw new ProviderError('Governance PR must be in the selected repository', 409);
    const expectedState = expected === 'merged'
      ? pull.merged === true && pull.state === 'closed'
      : pull.merged !== true && pull.state === 'open';
    if (!expectedState || String(pull.base?.ref) !== project.integration_branch) {
      complete = false;
      warnings.push(`Referenced PR is not a ${expected} same-repository PR targeting the integration branch`);
    }
    const title = String(pull.title ?? ''), body = String(pull.body ?? '');
    if (title.length > 20_000 || body.length > 40_000) { complete = false; warnings.push('Referenced PR metadata exceeds the bounded evidence limit'); }
    const commitsRaw = await this.pages(`${base.root}/pulls/${number}/commits`, base.token, undefined, { maxItems: 300, maxBytes: 2 * 1024 * 1024 });
    const filesRaw = await this.pages(`${base.root}/pulls/${number}/files`, base.token, undefined, { maxItems: 3_000, maxBytes: 2 * 1024 * 1024 });
    const expectedCommits = Number(pull.commits), expectedFiles = Number(pull.changed_files);
    if (!Number.isSafeInteger(expectedCommits) || commitsRaw.length !== expectedCommits || !Number.isSafeInteger(expectedFiles) || filesRaw.length !== expectedFiles) { complete = false; warnings.push('Referenced PR commit/file evidence is incomplete'); }
    const commits = commitsRaw.map(commit);
    const files = [] as GovernanceEvidence['pull_request']['files'];
    let patchBytes = 0;
    if (filesRaw.length > 3_000) { complete = false; warnings.push('Referenced PR has too many changed files for the bounded evidence limit'); }
    for (const value of filesRaw as Json[]) {
      const path = String(value.filename ?? '');
      if (!path || path.length > 700) { complete = false; warnings.push('Referenced PR contains an invalid file path'); continue; }
      const omitted = governancePathExcluded(path);
      const patch = typeof value.patch === 'string' ? value.patch : null;
      if (!omitted && patch === null) { complete = false; warnings.push(`Changed file ${path} has no complete text patch`); }
      if (!omitted && patch !== null) {
        patchBytes += Buffer.byteLength(patch);
        if (patchBytes > 600_000) throw new ProviderError('Referenced PR patches exceed the bounded aggregate evidence limit');
        if (patch.length > 80_000) { complete = false; warnings.push('Referenced PR patch exceeds the per-file evidence limit'); }
      }
      files.push({ path, status: String(value.status ?? 'modified'), patch: omitted ? null : patch && patch.length <= 80_000 ? patch : null, sha: typeof value.sha === 'string' ? value.sha : null, omitted });
    }
    const { data: tree } = await this.request(`${base.root}/git/trees/${base.integrationSha}?recursive=1`, base.token, 'GET', undefined, true);
    if (!Array.isArray(tree?.tree) || tree.truncated) { complete = false; warnings.push('Scoped AGENTS.md inventory is incomplete'); }
    const inventory = new Set<string>((Array.isArray(tree?.tree) ? tree.tree : []).filter((entry: Json) => entry?.type === 'blob').map((entry: Json) => String(entry.path ?? '')));
    const scopedPaths = applicableScopedPolicies(files.map(file => file.path), inventory);
    if (scopedPaths.length > 100) throw new ProviderError('Applicable scoped AGENTS.md files exceed the bounded limit');
    const scopedPolicies: NonNullable<GovernanceEvidence['scoped_policies']> = [];
    let scopedBytes = 0;
    for (const path of scopedPaths) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const { data } = await this.request(`${base.root}/contents/${encoded}?ref=${encodeURIComponent(base.integrationSha)}`, base.token);
      if (data?.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') { complete = false; warnings.push(`Scoped policy ${path} is incomplete`); continue; }
      const bytes = Buffer.from(data.content, 'base64'); scopedBytes += bytes.length;
      if (Number(data.size) !== bytes.length || bytes.length > 128_000 || scopedBytes > 512_000) throw new ProviderError('Scoped AGENTS.md content exceeds the bounded limit');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ProviderError(`Scoped policy ${path} is not valid UTF-8`, 409); }
      scopedPolicies.push({ path, sha: sha(data.sha), content });
    }
    const { data: verify } = await this.request(`${base.root}/pulls/${number}`, base.token, 'GET');
    if (String(verify?.head?.sha) !== String(pull.head?.sha) || String(verify?.updated_at) !== String(pull.updated_at) || String(verify?.base?.sha) !== String(pull.base?.sha) || String(verify?.base?.ref) !== String(pull.base?.ref) || String(verify?.state) !== String(pull.state) || verify?.merged !== pull.merged || String(verify?.title ?? '') !== title || String(verify?.body ?? '') !== body) { complete = false; warnings.push('Referenced PR changed during evidence collection'); }
    const { data: branch } = await this.request(`${base.root}/branches/${encodeURIComponent(project.integration_branch)}`, base.token);
    if (String(branch?.commit?.sha) !== base.integrationSha) { complete = false; warnings.push('Integration branch moved during evidence collection; re-request against the new baseline'); }
    if (base.policy.missing) { complete = false; warnings.push('Root AGENTS.md is missing on the pinned integration baseline'); }
    if (base.policy.truncated) { complete = false; warnings.push('Root AGENTS.md exceeds the bounded limit'); }
    return { repo_id: this.cfg.repoId, integration_sha: base.integrationSha, default_branch: base.repo.default_branch, policy: base.policy, scoped_policies: scopedPolicies, pull_request: { id: String(pull.id), repo_id: this.cfg.repoId, number, title, body, base_ref: String(pull.base.ref), base_sha: sha(pull.base.sha), head_sha: sha(pull.head.sha), merge_sha: pull.merge_commit_sha ? sha(pull.merge_commit_sha) : null, state: pull.merged === true ? 'merged' : pull.state === 'closed' ? 'closed' : 'open', draft: !!pull.draft, files, commits }, complete, warnings };
  }

  async createGovernanceBranch(name: string, baseSha: string): Promise<GovernanceBranch> {
    if (!governanceBranch(name) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new ProviderError('Invalid governance branch or base', 422);
    const token = await this.token(true);
    const { root } = await this.governanceRepository();
    try {
      const { data } = await this.request(`${root}/git/refs`, token, 'POST', { ref: `refs/heads/${name}`, sha: baseSha });
      const actual = sha(data?.object?.sha);
      if (actual !== baseSha) throw new ProviderError('Governance branch was not created from the pinned baseline', 409);
      return { name, sha: actual };
    } catch (error) {
      // A successful POST can be reported as a timeout. Re-read the fixed
      // deterministic branch before retrying; never force-update a collision.
      if (error instanceof ProviderError && (error.status === 422 || error.status === 429 || error.status >= 500) || !(error instanceof ProviderError)) {
        try {
          const { data } = await this.request(`${root}/branches/${encodeURIComponent(name)}`, token);
          const actual = sha(data?.commit?.sha);
          if (actual === baseSha) return { name, sha: actual };
          const { data: commitData } = await this.request(`${root}/commits/${actual}`, token);
          const app = await this.appIdentity();
          const authoredByApp = (value: any) => verifiedCommentAuthor(value, app);
          if (String(commitData?.commit?.message ?? '').includes('vf-kapo:') && (authoredByApp(commitData?.author) || authoredByApp(commitData?.committer))) return { name, sha: actual };
        } catch { /* preserve the original failure below */ }
      }
      throw error;
    }
  }

  async updateGovernancePolicy(branch: string, policySha: string, content: string): Promise<{ sha: string }> {
    if (!governanceBranch(branch) || !/^[a-f0-9]{40}$/.test(policySha) || typeof content !== 'string' || !content.length || Buffer.byteLength(content) > 1024 * 1024) throw new ProviderError('Invalid bounded governance policy update', 422);
    const token = await this.token(true);
    const { root } = await this.governanceRepository();
    const currentPath = `${root}/contents/AGENTS.md?ref=${encodeURIComponent(branch)}`;
    const current = await this.request(currentPath, token, 'GET');
    if (current.data?.type !== 'file') throw new ProviderError('Governance branch root AGENTS.md is unavailable', 409);
    if (String(current.data.sha) !== policySha) {
      if (current.data.encoding === 'base64' && typeof current.data.content === 'string' && Buffer.from(current.data.content, 'base64').toString('utf8') === content) return { sha: String(current.data.sha) };
      throw new ProviderError('Governance policy baseline changed before branch write', 409);
    }
    const { data } = await this.request(`${root}/contents/AGENTS.md`, token, 'PUT', { message: `vf-kapo: update root AGENTS.md for review`, content: Buffer.from(content, 'utf8').toString('base64'), branch, sha: policySha });
    const resultSha = String(data?.content?.sha ?? data?.commit?.sha ?? '');
    if (!resultSha) throw new ProviderError('Governance policy write response was incomplete');
    const verify = await this.request(currentPath, token, 'GET');
    if (verify.data?.type !== 'file' || verify.data.encoding !== 'base64' || typeof verify.data.content !== 'string' || Buffer.from(verify.data.content, 'base64').toString('utf8') !== content) throw new ProviderError('Governance policy write could not be verified');
    return { sha: String(verify.data.sha || resultSha) };
  }

  async governanceDiff(branch: string, baseSha: string): Promise<GovernanceDiff> {
    if (!governanceBranch(branch) || !/^[a-f0-9]{40}$/.test(baseSha)) throw new ProviderError('Invalid governance diff target', 422);
    const token = await this.token(true);
    const { root } = await this.governanceRepository();
    const { data } = await this.request(`${root}/compare/${baseSha}...${encodeURIComponent(branch)}?per_page=100&page=1`, token);
    if (!Array.isArray(data?.files) || data.files.length > 100) return { base_sha: baseSha, head_sha: String(data?.merge_base_commit?.sha ?? ''), files: [], complete: false, app_authored: false };
    const files = data.files.map((file: Json) => String(file.filename ?? ''));
    const headSha = String(data?.merge_commit_sha ?? data?.commits?.at(-1)?.sha ?? '');
    const validBase = typeof data.base_commit?.sha === 'string' && data.base_commit.sha === baseSha;
    const validHead = /^[a-f0-9]{40}$/.test(headSha);
    if (!validBase || !validHead || files.length !== 1 || files[0] !== 'AGENTS.md') return { base_sha: baseSha, head_sha: headSha, files, complete: false, app_authored: false };
    const { data: branchData } = await this.request(`${root}/branches/${encodeURIComponent(branch)}`, token);
    if (String(branchData?.commit?.sha ?? '') !== headSha) return { base_sha: baseSha, head_sha: headSha, files, complete: false, app_authored: false };
    const { data: commitData } = await this.request(`${root}/commits/${headSha}`, token);
    const app = await this.appIdentity();
    const authoredByApp = (value: any) => verifiedCommentAuthor(value, app);
    const appAuthored = authoredByApp(commitData?.author) || authoredByApp(commitData?.committer);
    const { data: policy } = await this.request(`${root}/contents/AGENTS.md?ref=${encodeURIComponent(branch)}`, token);
    if (policy?.type !== 'file' || policy.encoding !== 'base64' || typeof policy.content !== 'string' || Number(policy.size) > 1024 * 1024) return { base_sha: baseSha, head_sha: headSha, files, complete: false, app_authored: appAuthored };
    const bytes = Buffer.from(policy.content, 'base64');
    if (Number(policy.size) !== bytes.length) return { base_sha: baseSha, head_sha: headSha, files, complete: false, app_authored: appAuthored };
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return { base_sha: baseSha, head_sha: headSha, files, complete: false, app_authored: appAuthored }; }
    return { base_sha: baseSha, head_sha: headSha, files, complete: appAuthored, policy_content: content, app_authored: appAuthored };
  }

  async createGovernancePullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<GovernancePullRequestResult> {
    if (!governanceBranch(input.branch) || input.base.length < 1 || input.base.length > 240 || input.base === input.branch || typeof input.title !== 'string' || input.title.length > 240 || typeof input.body !== 'string' || input.body.length > 60_000) throw new ProviderError('Invalid governance draft PR request', 422);
    const token = await this.token(true);
    const { repo, root } = await this.governanceRepository();
    const app = await this.appIdentity();
    const authoredByApp = (value: any) => verifiedCommentAuthor(value, app);
    const isOwned = (value: Json) => authoredByApp(value.user);
    const create = async () => {
      const found = await this.pages(`${root}/pulls?state=open&head=${encodeURIComponent(`${repo.full_name.split('/')[0]}:${input.branch}`)}`, token) as Json[];
      const match = found.find(value => isOwned(value) && String(value.head?.ref) === input.branch && !!value.draft && String(value.base?.ref) === input.base && String(value.base?.repo?.id ?? '') === this.cfg.repoId && String(value.head?.repo?.id ?? '') === this.cfg.repoId && typeof value.body === 'string' && value.body === input.body);
      if (match?.id && Number(match.number) > 0) return { id: String(match.id), number: Number(match.number), url: String(match.html_url ?? `${repo.url}/pull/${match.number}`), head: input.branch, base: input.base, draft: true };
      const { data } = await this.request(`${root}/pulls`, token, 'POST', { title: input.title, head: input.branch, base: input.base, body: input.body, draft: true });
      if (!data?.id || Number(data.number) < 1 || !data.draft || !authoredByApp(data.user) || String(data.body ?? '') !== input.body || String(data.base?.ref ?? '') !== input.base || String(data.head?.ref ?? '') !== input.branch || String(data.base?.repo?.id ?? '') !== this.cfg.repoId || String(data.head?.repo?.id ?? '') !== this.cfg.repoId) throw new ProviderError('Governance draft PR response was not verified', 409);
      return { id: String(data.id), number: Number(data.number), url: String(data.html_url ?? `${repo.url}/pull/${data.number}`), head: input.branch, base: input.base, draft: true };
    };
    try { return await create(); } catch (error) {
      // A timed-out POST may have succeeded. Search only the fixed repository,
      // branch, and maintained marker before attempting one safe recovery.
      if (!(error instanceof ProviderError) || error.status >= 500 || error.status === 429) {
        const found = await this.pages(`${root}/pulls?state=open&head=${encodeURIComponent(`${repo.full_name.split('/')[0]}:${input.branch}`)}`, token) as Json[];
        const match = found.find(value => isOwned(value) && String(value.head?.ref) === input.branch && !!value.draft && String(value.base?.ref) === input.base && String(value.base?.repo?.id ?? '') === this.cfg.repoId && String(value.head?.repo?.id ?? '') === this.cfg.repoId && typeof value.body === 'string' && value.body === input.body);
        if (match?.id && Number(match.number) > 0) return { id: String(match.id), number: Number(match.number), url: String(match.html_url ?? `${repo.url}/pull/${match.number}`), head: input.branch, base: input.base, draft: true };
      }
      throw error;
    }
  }

  async maintainGovernanceComment(issueNumber: number, body: string): Promise<{ id: number; body: string }> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || typeof body !== 'string' || body.length > 60_000) throw new ProviderError('Invalid governance comment', 422);
    const token = await this.token();
    const app = await this.appIdentity();
    const { root } = await this.governanceRepository();
    const comments = await this.pages(`${root}/issues/${issueNumber}/comments`, token) as ProviderComment[];
    const marker = governanceMarker(this.cfg.repoId, issueNumber);
    const marked = comments.filter(comment => typeof comment.body === 'string' && comment.body.includes(marker));
    const verified = marked.filter(comment => verifiedCommentAuthor(comment.user, app));
    if (marked.length !== verified.length) throw new ProviderError('A governance marker belongs to an unverified human; refusing to edit or duplicate it', 409);
    const existing = verified[0];
    if (existing) {
      if (existing.body === body) return { id: existing.id, body: existing.body };
      const { data } = await this.request(`${root}/issues/comments/${existing.id}`, token, 'PATCH', { body });
      if (!data?.id || typeof data.body !== 'string' || !data.body.includes(marker) || !verifiedCommentAuthor(data.user, app)) throw new ProviderError('Governance comment update was not verified');
      return { id: Number(data.id), body: String(data.body) };
    }
    const { data } = await this.request(`${root}/issues/${issueNumber}/comments`, token, 'POST', { body });
    if (!data?.id || typeof data.body !== 'string' || !data.body.includes(marker) || !verifiedCommentAuthor(data.user, app)) throw new ProviderError('Governance comment creation was not verified');
    return { id: Number(data.id), body: String(data.body) };
  }

  async maintainGovernanceReview(pullNumber: number, body: string, event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<{ id: number; body: string }> {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1 || typeof body !== 'string' || body.length > 60_000) throw new ProviderError('Invalid governance PR review', 422);
    const token = await this.token(true);
    const app = await this.appIdentity();
    const { root } = await this.governanceRepository();
    const marker = body.match(/<!-- vf-kapo:main-review:[^>]+ -->/)?.[0];
    if (!marker) throw new ProviderError('Governance PR review marker is missing', 422);
    const reviews = await this.pages(`${root}/pulls/${pullNumber}/reviews`, token) as Json[];
    const marked = reviews.filter(review => typeof review.body === 'string' && review.body.includes(marker));
    const verified = marked.filter(review => verifiedCommentAuthor(review.user, app));
    if (marked.length !== verified.length) throw new ProviderError('A Main Agent review marker belongs to an unverified author', 409);
    if (verified[0]?.id) return { id: Number(verified[0].id), body: String(verified[0].body) };
    const { data } = await this.request(`${root}/pulls/${pullNumber}/reviews`, token, 'POST', { body, event });
    const expected = event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
    if (!data?.id || String(data.body ?? '') !== body || String(data.state ?? '').toUpperCase() !== expected || !verifiedCommentAuthor(data.user, app)) throw new ProviderError('Governance PR review response was not verified', 409);
    return { id: Number(data.id), body: String(data.body) };
  }
}
