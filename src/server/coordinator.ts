import { createHash, randomUUID } from 'node:crypto';
import type { Change, GitHubIssue, Link, Member, Project, ProjectItem, Status, SyncSnapshot, Task } from '../shared/types.js';
import { Store } from './db.js';
import { coordinationMarker } from './github.js';

export const RULE = 'github-native-v1';

/** Legacy explicit task-key parser retained only for reading legacy databases. */
export function markers(change: Change): { keys: string[]; evidence: string[] } {
  const found = new Map<string, string[]>();
  const scan = (text: string, location: string, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const key = match[1];
      found.set(key, [...(found.get(key) ?? []), location]);
    }
  };
  scan(change.title, 'pr.title', /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*)(?![A-Za-z0-9_])/g);
  scan(change.body, 'pr.body', /^\s*Task:\s*([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*)\s*$/gm);
  scan(change.branch, 'branch', /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*)(?![A-Za-z0-9_])/g);
  for (const commit of change.commits) scan(commit.message, `commit:${commit.sha}`, /\[([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*)\]/g);
  return { keys: [...found.keys()], evidence: [...found].flatMap(([key, where]) => where.map(location => `${location}: ${key}`)) };
}

function escapePattern(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Return only canonical references to Issues in the selected repository. A
 * bare #123 is accepted in a dedicated Task line or GitHub closing keyword;
 * arbitrary prose and foreign repo-qualified references are not associations.
 */
export function issueReferences(change: Change, repository: string): { numbers: number[]; evidence: string[] } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { numbers: [], evidence: [] };
  const repo = escapePattern(repository);
  const found = new Map<number, string[]>();
  const add = (value: string, evidence: string) => {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) found.set(number, [...(found.get(number) ?? []), evidence]);
  };
  const texts: [string, string][] = [[change.title, 'pr.title'], [change.body, 'pr.body'], ...change.commits.map(commit => [commit.message, `commit:${commit.sha}`] as [string, string])];
  for (const [text, location] of texts) {
    // Canonical GitHub issue URL, including only /issues/ URLs in this repo.
    for (const match of text.matchAll(new RegExp(`https?:\\/\\/github\\.com\\/${repo}\\/issues\\/([1-9][0-9]*)\\b`, 'gi'))) add(match[1], `${location}: issue URL`);
    // A Task line is intentionally strict, so foreign # references do not leak in.
    for (const match of text.matchAll(new RegExp(`^\\s*Task:\\s*(?:(?:${repo})#)?#?([1-9][0-9]*)\\s*$`, 'gmi'))) add(match[1], `${location}: Task: #${match[1]}`);
    // GitHub closing keywords may be bare or explicitly repo-qualified.
    for (const match of text.matchAll(new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:(?:${repo})#)?#?([1-9][0-9]*)\\b`, 'gmi'))) add(match[1], `${location}: closing keyword #${match[1]}`);
    // Qualified refs elsewhere are accepted only for the selected repository.
    for (const match of text.matchAll(new RegExp(`\\b${repo}#([1-9][0-9]*)\\b`, 'gi'))) add(match[1], `${location}: ${repository}#${match[1]}`);
  }
  return { numbers: [...found.keys()], evidence: [...found].flatMap(([number, locations]) => locations.map(location => `${location}: ${number}`)) };
}

export function githubCommentBody(change: Change, project: Project, issue?: GitHubIssue): string {
  const number = change.number ?? 0;
  const marker = coordinationMarker(project.repo_id, number);
  const target = issue ? `Issue [#${issue.number}](${issue.url})` : 'a GitHub Issue in the selected repository';
  if (issue) return `${marker}\n### vf-kapo coordination notice — resolved\nThis pull request is associated with ${target}. Continue managing the Issue and Project status in GitHub.\n\nObserved revision: "${change.head_sha}"\nChange: ${change.url}`;
  return `${marker}\n### vf-kapo coordination notice\nThis pull request is observed by vf-kapo but is not associated with a single current GitHub Issue.\n\n- Create or choose ${target} in GitHub.\n- Add "Task: #<issue-number>" to this PR body, or use a GitHub closing keyword such as "Fixes #123".\n- Keep the Issue content, acceptance criteria, assignees, closed state, and Project status in GitHub. vf-kapo only reads and reports those facts.\n\nObserved revision: "${change.head_sha}"\nChange: ${change.url}`;
}

export function canOwn(member: Member | undefined, task: Task) { return !!member?.active && (member.role === 'developer' || member.role === 'contributor' && member.id === task.owner); }

export function projectStatus(task: Task, pairs: { link: Link; change: Change }[], project: Project, now = Date.now()): { status: Status; reason: string | null } {
  const required = pairs.filter(value => !value.link.superseded_reason);
  const pause = (reason: string) => ({ status: task.status, reason });
  if (!project.confirmed || project.init === 'pending' || project.error || now - project.last_sync > 600_000) return pause('Synchronization pending, stale, or failed');
  if (required.some(value => value.link.state === 'disputed' || !value.change.complete || value.change.integrity || now - value.change.observed_at > 600_000)) return pause('Incomplete or disputed Git evidence requires review');
  if (required.some(value => value.change.state === 'closed' || value.change.state === 'deleted')) return pause('Abandoned PR or removed branch evidence requires review');
  const changes = required.map(value => value.change);
  const prs = changes.filter(change => change.kind === 'pr');
  const done = !!task.completion_pr_id && prs.some(change => change.id === task.completion_pr_id) && prs.every(change => change.state === 'merged' && change.base_ref === project.integration_branch) && !changes.some(change => change.kind === 'direct_commit' || change.kind === 'branch' && change.commits.length > 0);
  if (done) return { status: 'done', reason: null };
  if (task.status === 'done' && changes.some(change => change.state !== 'merged')) return pause('New work on Done task requires Developer reopen confirmation');
  if (prs.some(change => change.state === 'open' && !change.draft)) return { status: 'review', reason: null };
  if (changes.some(change => change.kind === 'pr' || change.commits.length > 0)) return { status: 'in_progress', reason: null };
  return { status: task.planning_status, reason: null };
}

function nativeProject(project: Project) { return project.source_of_truth === 'github' || !!project.project_node_id; }

function nativeIssueCoordinate(store: Store, project: Project) {
  const issues = store.all('github_issue').filter(issue => issue.repo_id === project.repo_id);
  const items = store.all('project_item').filter(item => item.project_node_id === project.project_node_id);
  for (const issue of issues) {
    const subject = `issue:${issue.repo_id}:${issue.number}`;
    const item = items.find(value => value.content_type === 'Issue' && value.issue_number === issue.number && value.repo_id === issue.repo_id);
    if (!item) {
      store.notice('issue_missing_project', subject, String(issue.updated_at), `GitHub Issue #${issue.number} is not a member of the configured Project; status is unavailable`, null);
    } else {
      store.resolve('issue_missing_project', subject);
      const statusSubject = `${subject}:status`;
      if (item.status === null) store.notice('issue_unset_project_status', statusSubject, String(issue.updated_at), `GitHub Issue #${issue.number} has no value in the Project Status field`, null);
      else store.resolve('issue_unset_project_status', statusSubject);
    }
  }

  for (const change of store.all('git_change').filter(value => !value.canonical_id)) {
    if (change.kind === 'branch' && !change.commits.length && change.state !== 'deleted') continue;
    const refs = issueReferences(change, project.full_name);
    const matching = refs.numbers.map(number => issues.find(issue => issue.number === number && issue.repo_id === project.repo_id)).filter((issue): issue is GitHubIssue => !!issue);
    const subject = change.id;
    const exactlyOne = refs.numbers.length === 1 && matching.length === 1;
    const reason = refs.numbers.length > 1 ? 'Multiple same-repository Issue references require review' : refs.numbers.length === 1 && !matching.length ? `Referenced GitHub Issue #${refs.numbers[0]} was not observed in the selected repository` : 'No exact same-repository GitHub Issue reference was observed';
    if (exactlyOne) store.resolve('untracked_change', subject);
    else store.notice('untracked_change', subject, change.head_sha, reason, null);
    if (refs.numbers.length === 1 && !matching.length) store.notice('issue_reference_unresolved', subject, change.head_sha, reason, null);
    else store.resolve('issue_reference_unresolved', subject);

    // Keep one durable app-owned comment for every unresolved PR. The worker
    // delivers it; coordination never performs network I/O in a transaction.
    if (change.kind === 'pr' && change.number) {
      const subjectKey = `pr:${change.id}`;
      const previous = store.all('github_comment').find(comment => comment.subject === subjectKey);
      if (exactlyOne && !previous) continue;
      const body = githubCommentBody(change, project, exactlyOne ? matching[0] : undefined);
      const hash = createHash('sha256').update(body).digest('hex');
      const comment = previous && previous.body_hash === hash ? previous : {
        id: previous?.id ?? randomUUID(), subject: subjectKey, change_id: change.id, marker: coordinationMarker(project.repo_id, change.number), body, body_hash: hash, comment_id: previous?.comment_id ?? null, state: 'queued' as const, attempts: previous?.attempts ?? 0, error: null, updated_at: Date.now(),
      };
      if (!previous || previous.body_hash !== hash || previous.state === 'blocked') store.put('github_comment', comment.id, comment);
      if (!previous || previous.body_hash !== hash || previous.state !== 'delivered') store.enqueue('github_comment', { comment_id: comment.id, change_id: change.id }, `github-comment:${change.id}:${hash}:${change.version}`);
    }
  }
}

export function coordinate(store: Store) {
  const project = store.get('project', '1');
  if (!project) return;
  if (nativeProject(project)) {
    nativeIssueCoordinate(store, project);
    return;
  }

  // Legacy local-PM projection is intentionally isolated for old databases. A
  // new GitHub-native project never reaches this branch and cannot gain a
  // second task/status authority from it.
  const tasks = store.all('task');
  for (const change of store.all('git_change').filter(value => !value.canonical_id)) {
    if (change.kind === 'branch' && !change.commits.length && change.state !== 'deleted') continue;
    let link = store.get('task_change', change.id);
    const mk = markers(change);
    const task = tasks.find(value => value.key === mk.keys[0] && !value.archived);
    const actor = change.actor ? store.get('member', change.actor) : undefined;
    let warning = '';
    if (link) {
      const linked = tasks.find(value => value.id === link!.task_id);
      if (!linked) continue;
      if (link.source === 'metadata' && (mk.keys.length !== 1 || mk.keys[0] !== linked.key || !canOwn(actor, linked))) {
        if (link.state !== 'disputed') { link.state = 'disputed'; store.put('task_change', change.id, link); store.audit(RULE, 'association.disputed', linked.id, { change: change.id, markers: mk }); }
        warning = 'Automatic association evidence removed, conflicting, or no longer authorized; confirm explicitly';
      } else if (mk.keys.some(key => key !== linked.key)) warning = 'Metadata conflicts with confirmed manual association';
    } else if (mk.keys.length === 1 && task && canOwn(actor, task) && task.status !== 'done' && change.complete && !change.integrity && !store.db.prepare('SELECT 1 FROM association_rejection WHERE change_id=?').get(change.id)) {
      link = { change_id: change.id, task_id: task.id, state: 'confirmed', source: 'metadata', actor: RULE, evidence: mk.evidence, revision: change.head_sha, superseded_reason: null };
      store.put('task_change', change.id, link); store.audit(RULE, 'association.created', task.id, link);
    } else warning = mk.keys.length > 1 ? 'Multiple task identifiers require confirmation' : mk.keys.length && !task ? 'Unknown task identifier' : task?.status === 'done' ? 'Done task requires explicit Developer reopen' : mk.keys.length ? 'Actor not authorized or evidence incomplete' : 'No explicit task identifier';
    if (!link && store.db.prepare('SELECT 1 FROM association_rejection WHERE change_id=?').get(change.id)) warning = 'Manually unlinked; explicit confirmation required before reassociation';
    const recipient = link ? tasks.find(value => value.id === link!.task_id)?.owner ?? null : actor?.active ? actor.id : null;
    if (!link) store.notice('untracked_change', change.id, change.head_sha, warning, recipient); else store.resolve('untracked_change', change.id);
    if (warning && link) store.notice('association_conflict', change.id, change.head_sha, warning, recipient); else if (link?.state !== 'disputed') store.resolve('association_conflict', change.id);
    if ((change.state === 'closed' || change.state === 'deleted' || change.integrity) && !link?.superseded_reason) store.notice('integrity_review', change.id, change.head_sha, change.integrity ?? 'Closed without merge or deleted branch evidence', recipient); else store.resolve('integrity_review', change.id);
    const explanations = store.all('explanation').filter(value => value.change_id === change.id);
    if (!explanations.some(value => value.revision_sha === change.head_sha)) store.notice(explanations.length ? 'stale_explanation' : 'missing_explanation', change.id, change.head_sha, 'Contributor explanation requested for current head', recipient);
    if (explanations.some(value => value.revision_sha === change.head_sha)) { store.resolve('stale_explanation', change.id); store.resolve('missing_explanation', change.id); }
  }
  for (const task of tasks.filter(value => !value.archived)) {
    const pairs = store.all('task_change').filter(link => link.task_id === task.id).map(link => ({ link, change: store.get('git_change', link.change_id)! })).filter(value => value.change && !value.change.canonical_id);
    const projection = projectStatus(task, pairs, project);
    if (task.status === 'done' && projection.reason?.startsWith('New work')) store.notice('reopen_required', task.id, String(task.version), projection.reason, task.owner); else store.resolve('reopen_required', task.id);
    if (pairs.length && (!task.description || !task.owner || !task.criteria.length)) store.notice('needs_clarification', task.id, String(task.version), 'Tracked task lacks owner, description, or criteria', task.owner); else store.resolve('needs_clarification', task.id);
    if (pairs.length && pairs.filter(value => !value.link.superseded_reason).every(value => value.change.kind === 'pr' && value.change.state === 'merged') && !task.completion_pr_id) store.notice('completion_intent', task.id, String(task.version), 'Designate a completion PR; merge alone is not completion', task.owner); else store.resolve('completion_intent', task.id);
    const next = task.sync_mode === 'auto' && !task.attention_kind ? projection.status : task.status;
    if (next !== task.status || projection.status !== task.suggested_status || projection.reason !== task.projection_reason) {
      const before = { ...task }; task.status = next; task.suggested_status = projection.status; task.projection_reason = projection.reason; task.version++; task.updated_at = Date.now(); store.put('task', task.id, task); store.audit(RULE, 'task.projection', task.id, { before, after: task });
    }
  }
}

/** Apply only a complete provider snapshot; callers own a short transaction. */
export function applySnapshot(store: Store, snapshot: SyncSnapshot) {
  const project = store.get('project', '1');
  if (!project) return;
  const native = nativeProject(project);
  if (native && snapshot.project && project.project_node_id && snapshot.project.node_id !== project.project_node_id) throw new Error('Project observation does not match the confirmed project node');
  if (snapshot.default_branch !== project.integration_branch) store.notice('default_branch_changed', 'project', snapshot.default_branch, 'Admin must explicitly confirm the new integration branch'); else store.resolve('default_branch_changed', 'project');
  const oldChanges = store.all('git_change');
  for (const incoming of snapshot.changes) {
    let change = { ...incoming };
    let old = oldChanges.find(value => value.identity === change.identity);
    if (change.kind === 'branch') {
      old = oldChanges.find(value => value.kind === 'branch' && value.branch === change.branch && value.state !== 'deleted' && !value.canonical_id);
      if (old) { change.id = old.id; change.identity = old.identity; change.incarnation = old.incarnation; }
      else { change.incarnation = randomUUID(); change.identity = `${project.repo_id}:branch:${change.branch}:${change.incarnation}`; change.id = change.identity; }
    }
    if (old) {
      change.canonical_id = old.canonical_id;
      if (old.kind !== 'direct_commit' && old.state !== 'merged' && old.commits.some(commit => !change.commits.some(next => next.sha === commit.sha)) && change.state !== 'merged') change.integrity = 'Force-push or base movement removed observed evidence; reconfirm association';
      change.integrity = change.integrity ?? (old.integrity === 'Canonical PR refresh failed; last known evidence preserved' && change.complete ? null : old.integrity);
      change.version = old.version;
      if (JSON.stringify({ ...old, observed_at: 0, version: 0 }) !== JSON.stringify({ ...change, observed_at: 0, version: 0 })) { change.version++; store.history(old); }
    }
    store.put('git_change', change.id, change); store.commits(change);
  }
  if (!native) for (const pull of store.all('git_change').filter(value => value.kind === 'pr' && value.complete)) for (const branch of store.all('git_change').filter(value => value.kind === 'branch' && !value.canonical_id && value.branch === pull.branch && value.commits.length > 0)) {
    if (!branch.commits.every(branchCommit => pull.commits.some(prCommit => prCommit.sha === branchCommit.sha))) continue;
    if (pull.state !== 'open' && branch.head_sha !== pull.head_sha) continue;
    const branchLink = store.get('task_change', branch.id), pullLink = store.get('task_change', pull.id);
    if (branchLink && pullLink && branchLink.task_id !== pullLink.task_id) { branchLink.state = 'disputed'; pullLink.state = 'disputed'; store.put('task_change', branch.id, branchLink); store.put('task_change', pull.id, pullLink); store.notice('association_conflict', pull.id, pull.head_sha, 'Branch and PR have conflicting links'); continue; }
    if (branchLink && !pullLink) { store.put('task_change', pull.id, { ...branchLink, change_id: pull.id }); const task = store.get('task', branchLink.task_id); if (task?.completion_pr_id === branch.id) { task.completion_pr_id = pull.id; store.put('task', task.id, task); } }
    branch.canonical_id = pull.id; branch.version++; store.put('git_change', branch.id, branch); store.resolve('untracked_change', branch.id); store.resolve('missing_explanation', branch.id); store.resolve('stale_explanation', branch.id);
    for (const explanation of store.all('explanation').filter(value => value.change_id === branch.id)) { explanation.change_id = pull.id; store.put('explanation', explanation.id, explanation); }
    store.audit(RULE, 'change.canonicalized', pull.id, { branch: branch.id });
  }
  for (const old of oldChanges.filter(value => value.kind === 'branch' && value.state !== 'deleted' && !value.canonical_id && !snapshot.branches.includes(value.branch))) {
    const current = store.get('git_change', old.id)!; if (current.canonical_id) continue;
    current.state = 'deleted'; current.integrity = 'Branch disappeared; prior history retained'; current.version++; current.observed_at = Date.now(); store.history(old); store.put('git_change', old.id, current);
  }

  // Native observations are atomically replaced only after the provider has
  // completed every page and validated its status field. A failed/partial
  // GraphQL response therefore never clears these rows.
  if (snapshot.issues !== undefined) {
    const incoming = new Set(snapshot.issues.map(issue => issue.id));
    for (const issue of store.all('github_issue').filter(value => value.repo_id === project.repo_id && !incoming.has(value.id))) store.db.prepare('DELETE FROM github_issue WHERE id=?').run(issue.id);
    for (const issue of snapshot.issues) store.put('github_issue', issue.id, issue);
  }
  if (snapshot.project) {
    const incoming = new Set(snapshot.project.items.map(item => item.id));
    for (const item of store.all('project_item').filter(value => value.project_node_id === snapshot.project!.node_id && !incoming.has(value.id))) store.db.prepare('DELETE FROM project_item WHERE id=?').run(item.id);
    for (const item of snapshot.project.items) store.put('project_item', item.id, item);
    project.source_of_truth = 'github'; project.project_node_id = snapshot.project.node_id; project.project_status_field_id = snapshot.project.status_field_id; project.project_status_field_name = snapshot.project.status_field_name; project.project_url = snapshot.project.url;
  }
  project.last_sync = Date.now(); project.checkpoint = snapshot.integration_sha; project.init = snapshot.empty ? 'empty' : 'ready'; project.error = null; project.full_name = snapshot.full_name; project.url = snapshot.url; project.default_branch = snapshot.default_branch; project.gaps = [...new Set([...project.gaps, ...snapshot.gaps])].slice(-100);
  store.put('project', '1', project);
  if (snapshot.context && !store.get('context_snapshot', snapshot.context.sha)) store.put('context_snapshot', snapshot.context.sha, snapshot.context);
  store.resolve('sync_error', 'project');
  coordinate(store);
}
