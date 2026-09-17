import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ActionItem, Change, ContextSnapshot, Explanation, GitHubComment, GitHubIssue, GovernanceRequest, Job, Link, Member, Project, ProjectItem, Task } from '../shared/types.js';

type Entities = {
  project: Project;
  member: Member;
  task: Task;
  git_change: Change;
  task_change: Link;
  explanation: Explanation;
  action_item: ActionItem;
  context_snapshot: ContextSnapshot;
  event_job: Job;
  github_issue: GitHubIssue;
  project_item: ProjectItem;
  github_comment: GitHubComment;
  governance_request: GovernanceRequest;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES(1);
      ${['project', 'member', 'task', 'git_change', 'task_change', 'explanation', 'action_item', 'context_snapshot', 'event_job', 'github_issue', 'project_item', 'github_comment', 'governance_request'].map(table => `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));`).join('\n')}
      CREATE UNIQUE INDEX IF NOT EXISTS task_key ON task(json_extract(data,'$.key'));
      CREATE UNIQUE INDEX IF NOT EXISTS change_identity ON git_change(json_extract(data,'$.identity'));
      CREATE UNIQUE INDEX IF NOT EXISTS action_subject ON action_item(json_extract(data,'$.kind'),json_extract(data,'$.subject'));
      CREATE UNIQUE INDEX IF NOT EXISTS issue_identity ON github_issue(json_extract(data,'$.repo_id'),json_extract(data,'$.number'));
      CREATE UNIQUE INDEX IF NOT EXISTS project_item_identity ON project_item(json_extract(data,'$.project_node_id'),json_extract(data,'$.id'));
      CREATE UNIQUE INDEX IF NOT EXISTS github_comment_subject ON github_comment(json_extract(data,'$.subject'));
      CREATE TABLE IF NOT EXISTS git_commit(sha TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS membership(change_id TEXT NOT NULL, sha TEXT NOT NULL, current INTEGER NOT NULL, PRIMARY KEY(change_id,sha));
      CREATE TABLE IF NOT EXISTS change_history(id INTEGER PRIMARY KEY, change_id TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS association_rejection(change_id TEXT PRIMARY KEY, revision TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_entry(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_entry BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_entry BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS session(hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_state(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_token(hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, label TEXT NOT NULL, scopes TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER);
      CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL);
      COMMIT;
    `);
  }

  get<K extends keyof Entities>(table: K, id: string): Entities[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Entities[K] : undefined;
  }

  all<K extends keyof Entities>(table: K): Entities[K][] {
    return (this.db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]).map(row => JSON.parse(row.data) as Entities[K]);
  }

  put<K extends keyof Entities>(table: K, id: string, value: Entities[K]) {
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(value));
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  audit(actor: string, action: string, entity: string, data: unknown) {
    this.db.prepare('INSERT INTO audit_entry(actor,action,entity,data,at) VALUES(?,?,?,?,?)').run(actor, action, entity, JSON.stringify(data), Date.now());
  }

  history(change: Change) {
    this.db.prepare('INSERT INTO change_history(change_id,data,at) VALUES(?,?,?)').run(change.id, JSON.stringify(change), Date.now());
  }

  commits(change: Change) {
    this.db.prepare('UPDATE membership SET current=0 WHERE change_id=?').run(change.id);
    for (const commit of change.commits) {
      this.db.prepare('INSERT INTO git_commit VALUES(?,?) ON CONFLICT(sha) DO UPDATE SET data=excluded.data').run(commit.sha, JSON.stringify(commit));
      this.db.prepare('INSERT INTO membership VALUES(?,?,1) ON CONFLICT(change_id,sha) DO UPDATE SET current=1').run(change.id, commit.sha);
    }
  }

  enqueue(type: string, payload: unknown = {}, id: string = randomUUID()): string {
    if (this.get('event_job', id)) return id;
    this.put('event_job', id, { id, type, payload: JSON.stringify(payload), state: 'queued', attempts: 0, next_at: Date.now(), lease_until: 0, lease_token: null, error: null, created_at: Date.now() });
    return id;
  }

  notice(kind: string, subject: string, revision: string, reason: string, recipient: string | null = null) {
    const old = this.all('action_item').find(item => item.kind === kind && item.subject === subject);
    if (old && old.revision === revision && old.reason === reason && old.state !== 'resolved') return old;
    const item: ActionItem = {
      id: old?.id ?? randomUUID(),
      kind,
      subject,
      revision,
      reason,
      recipient,
      state: old?.state === 'dismissed' && old.revision === revision ? 'dismissed' : 'open',
      resolution_reason: null,
      updated_at: Date.now(),
    };
    this.put('action_item', item.id, item);
    return item;
  }

  resolve(kind: string, subject: string) {
    for (const item of this.all('action_item').filter(value => value.kind === kind && value.subject === subject && value.state !== 'resolved')) {
      item.state = 'resolved';
      item.updated_at = Date.now();
      this.put('action_item', item.id, item);
    }
  }

  close() { this.db.close(); }
}

export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function requireValue<T>(value: T | undefined | null, message = 'Not found'): T {
  if (value == null) throw new ApiError(404, message);
  return value;
}
