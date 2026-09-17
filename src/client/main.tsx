import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Change, GitHubIssue, ProjectItem } from '../shared/types.js';
import './styles.css';

type Page = 'inbox' | 'context' | 'settings';
type Me = { member: { id: string; login: string; role: string; active: boolean }; csrf_token: string | null; demo: boolean; scopes: string[] };
type IssueView = GitHubIssue & { project_item: ProjectItem | null };
type Project = Record<string, any>;
type ApiRequest = (url: string, init?: RequestInit) => Promise<any>;

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authConfig, setAuthConfig] = useState<{ demo: boolean; login_url: string | null } | null>(null);
  const [issues, setIssues] = useState<IssueView[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [inbox, setInbox] = useState<any[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [health, setHealth] = useState<any>(null);
  const [page, setPage] = useState<Page>('inbox');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [csrf, setCsrf] = useState<string | null>(null);

  const request = useCallback(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (csrf && init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-CSRF-Token', csrf);
    const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
  }, [csrf]);

  const fetchAll = useCallback(async (path: string, get: ApiRequest) => {
    const items: any[] = [];
    let offset = 0;
    for (;;) {
      const separator = path.includes('?') ? '&' : '?';
      const result = await get(`${path}${separator}limit=100&offset=${offset}`);
      items.push(...result.items);
      if (result.next_offset === null) return items;
      if (!Number.isInteger(result.next_offset) || result.next_offset <= offset) throw new Error('Invalid pagination response');
      offset = result.next_offset;
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const current = await request('/api/me');
      setMe(current); setCsrf(current.csrf_token);
      const get: ApiRequest = (url, init) => request(url, init);
      const [issueItems, changeItems, inboxItems, projectResult, healthResult] = await Promise.all([
        fetchAll('/api/issues', get), fetchAll('/api/changes', get), fetchAll('/api/inbox', get), request('/api/project'), request('/api/health/sync'),
      ]);
      setIssues(issueItems); setChanges(changeItems); setInbox(inboxItems);
      setProject(projectResult.project); setHealth(healthResult); setError('');
    } catch (e) {
      if (e instanceof Error && /Sign in|required|401|Unauthenticated/i.test(e.message)) {
        setMe(null); setCsrf(null); setAuthConfig(await fetch('/auth/config').then(response => response.json()).catch(() => null));
      } else setError(e instanceof Error ? e.message : 'Unable to load GitHub observations');
    }
  }, [fetchAll, request]);

  useEffect(() => { void load(); }, [load]);

  const run = async (operation: () => Promise<any>, success?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); if (success) setNotice(success); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { setBusy(false); }
  };

  const loginDemo = () => run(async () => { const result = await request('/auth/demo', { method: 'POST', body: '{}' }); setCsrf(result.csrf_token); }, 'Signed in to the isolated GitHub-shaped FAKE demo');
  const logout = () => run(async () => { await request('/api/auth/logout', { method: 'POST' }); setMe(null); }, 'Signed out');

  if (!me) return <AuthScreen config={authConfig} onDemo={loginDemo} busy={busy} error={error} />;
  const openCount = inbox.filter(item => item.state === 'open').length;
  return <div className="app-shell">
    <header className="topbar"><div><strong className="brand">vf-kapo</strong><span className="tagline">GitHub-native coordination</span></div><div className="account"><span>{me.member.login}</span><span className="role">{me.member.role}</span>{me.demo && <span className="fake">FAKE DEMO</span>}<button className="secondary" onClick={() => void logout()} disabled={busy}>Log out</button></div></header>
    <nav className="nav" aria-label="Primary navigation">
      <button className={page === 'inbox' ? 'nav-active' : ''} onClick={() => setPage('inbox')}>Inbox{openCount > 0 && <span className="count">{openCount}</span>}</button>
      <button className={page === 'context' ? 'nav-active' : ''} onClick={() => setPage('context')}>Context</button>
      <button className={page === 'settings' ? 'nav-active' : ''} onClick={() => setPage('settings')}>Settings</button>
    </nav>
    <main className="content">
      {error && <div className="alert error" role="alert"><strong>GitHub observation needs attention.</strong> {error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {notice && <div className="alert success" role="status">{notice}</div>}
      {page === 'inbox' && <Inbox items={inbox} issues={issues} changes={changes} request={request} run={run} busy={busy} />}
      {page === 'context' && <Context project={project} issues={issues} request={request} onError={setError} />}
      {page === 'settings' && <Settings me={me} project={project} health={health} request={request} run={run} busy={busy} />}
    </main>
  </div>;
}

function AuthScreen({ config, onDemo, busy, error }: { config: { demo: boolean; login_url: string | null } | null; onDemo: () => void; busy: boolean; error: string }) {
  return <main className="auth-screen"><section className="auth-card"><p className="eyebrow">GITHUB-NATIVE PILOT</p><h1>vf-kapo</h1><p>Read GitHub Issues and one Projects v2 project, then route exceptions without creating a second task board.</p>{error && <div className="alert error" role="alert">{error}</div>}{!config ? <p>Checking sign-in configuration…</p> : <div className="auth-actions">{config.demo && <button onClick={onDemo} disabled={busy}>Enter isolated GitHub-shaped FAKE demo</button>}{config.login_url && <a className="button" href={config.login_url}>Sign in with GitHub</a>}</div>}<small>Issue content, acceptance criteria, assignees, closed state, and Project status remain in GitHub.</small></section></main>;
}

function Inbox({ items, issues, changes, request, run, busy }: { items: any[]; issues: IssueView[]; changes: Change[]; request: ApiRequest; run: (operation: () => Promise<any>, success?: string) => Promise<void>; busy: boolean }) {
  const [selected, setSelected] = useState<any>(null);
  const [review, setReview] = useState<any>(null);
  const open = items.filter(item => item.state === 'open');
  const selectedChange = selected ? changes.find(change => change.id === selected.subject) : undefined;
  const selectedIssue = selected ? issues.find(issue => selected.reason?.includes(`#${issue.number}`)) : undefined;
  useEffect(() => {
    if (selected?.kind !== 'governance_review') { setReview(null); return; }
    void request(`/api/governance/${encodeURIComponent(selected.subject)}`).then(setReview).catch(() => setReview(null));
  }, [request, selected]);
  const copyContext = async () => {
    if (!selected) return;
    const query = selectedChange ? `?change=${encodeURIComponent(selectedChange.id)}` : '';
    const context = await request(`/api/project/context${query}`);
    const text = JSON.stringify({ action: selected.reason, issue: selectedIssue?.url ?? null, change: selectedChange?.url ?? null, governance: review, context }, null, 2);
    await navigator.clipboard?.writeText(text);
  };
  return <>
    <div className="page-heading"><div><p className="eyebrow">EXCEPTION INBOX</p><h1>GitHub needs attention</h1><p className="muted">This inbox is a coordination view. Fix Issue, PR, Project, or policy facts in GitHub; vf-kapo does not maintain a local task or status authority.</p></div></div>
    {open.length === 0 ? <section className="inbox-detail"><h2>No open exceptions</h2><p className="muted">The latest bounded GitHub observations have no unresolved coordination warnings.</p></section> : <div className="split"><section className="inbox-list" aria-label="Open exceptions">{open.map(item => <button className={`inbox-item ${selected?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item)}><strong>{item.kind.replaceAll('_', ' ')}</strong><span>{item.reason}</span><small>Observed revision: {item.revision}</small></button>)}</section><section className="inbox-detail" aria-label="Exception details">{selected ? <><p className="eyebrow">EXCEPTION DETAIL</p><h2>{selected.kind.replaceAll('_', ' ')}</h2><p>{selected.reason}</p>{selectedChange && <p><a href={selectedChange.url} target="_blank" rel="noreferrer">Open pull request in GitHub ↗</a></p>}{selectedIssue && <p><a href={selectedIssue.url} target="_blank" rel="noreferrer">Open Issue #{selectedIssue.number} in GitHub ↗</a></p>}{review && <div className="change-card"><strong>Governance review: {review.state}</strong><span className="change-kind">{review.decision ?? 'pending'}</span>{review.proposal_url && <p><a href={review.proposal_url} target="_blank" rel="noreferrer">Open human-reviewed draft policy PR ↗</a></p>}</div>}<p className="muted">Resolve the underlying condition in GitHub, then wait for the next reconciliation. The service will not link, close, move, merge, or adopt policy locally.</p><div className="form-actions"><button onClick={() => void copyContext()} disabled={busy}>Copy GitHub context</button>{selectedChange?.url && <a className="button secondary" href={selectedChange.url} target="_blank" rel="noreferrer">Open GitHub</a>}</div></> : <p className="muted">Select an exception to see evidence and GitHub-native instructions.</p>}</section></div>}
  </>;
}

function Context({ project, issues, request, onError }: { project: Project | null; issues: IssueView[]; request: ApiRequest; onError: (message: string) => void }) {
  const [context, setContext] = useState<any>(null);
  useEffect(() => { void request('/api/project/context').then(setContext).catch((e: Error) => onError(e.message)); }, [request, onError]);
  return <><div className="page-heading"><div><p className="eyebrow">READ-ONLY CONTEXT</p><h1>GitHub project facts</h1><p className="muted">Issues and Project v2 observations are cached with their source links. Unknown or custom status names remain unchanged.</p></div></div><div className="context-grid"><section className="context-main"><h2>{project?.full_name ?? 'Selected repository'}</h2><dl><dt>Repository</dt><dd>{project?.url ? <a href={project.url} target="_blank" rel="noreferrer">{project.url} ↗</a> : 'Not synchronized'}</dd><dt>Project</dt><dd>{project?.project_url ? <a href={project.project_url} target="_blank" rel="noreferrer">{project.project_url} ↗</a> : project?.project_node_id ?? 'Not synchronized'}</dd><dt>Status field</dt><dd>{project?.project_status_field_name ?? 'Not validated yet'}</dd><dt>Snapshot</dt><dd>{context?.snapshot?.sha ?? 'Pending; no empty policy is implied'}</dd></dl><h2>Observed Issues ({issues.length})</h2>{issues.length === 0 ? <p className="muted">No synchronized Issues yet. Check Settings → health.</p> : <div>{issues.map(issue => <article className="change-card" key={issue.id}><div className="change-title"><div><strong>#{issue.number} {issue.title}</strong><span className="change-kind">{issue.state} · Project status: {issue.project_item?.status ?? 'unset'}</span></div><a href={issue.url} target="_blank" rel="noreferrer">Open GitHub ↗</a></div><p>{issue.body}</p>{!issue.project_item && <p className="warning">This Issue is not a member of the configured Project; no local status is invented.</p>}</article>)}</div>}{context?.governance?.length > 0 && <><h2>Governance reviews</h2>{context.governance.map((review: any) => <article className="change-card" key={review.id}><strong>Issue #{review.issue_number} · PR #{review.pr_number}</strong><span className="change-kind">{review.state} · {review.decision ?? 'pending'}</span>{review.proposal_url && <p><a href={review.proposal_url} target="_blank" rel="noreferrer">Open draft policy PR ↗</a></p>}{review.error && <p className="warning">{review.error}</p>}</article>)}</>}{context?.snapshot?.documents && <><h2>Repository context</h2>{Object.entries(context.snapshot.documents).map(([name, doc]: [string, any]) => <article className="change-card" key={name}><strong>{name}</strong>{doc.missing ? <p className="muted">Missing</p> : <pre>{doc.truncated ? 'Document exceeds the bounded limit; body omitted.' : doc.content}</pre>}</article>)}</>}</section><aside><h2>Warnings</h2>{(context?.snapshot?.warnings ?? ['Context synchronization is pending.']).map((warning: string) => <p className="warning" key={warning}>{warning}</p>)}</aside></div></>;
}

function Settings({ me, project, health, request, run, busy }: { me: Me; project: Project | null; health: any; request: ApiRequest; run: (operation: () => Promise<any>, success?: string) => Promise<void>; busy: boolean }) {
  return <><div className="page-heading"><div><p className="eyebrow">CONNECTION & HEALTH</p><h1>Settings</h1><p className="muted">Configuration changes happen through deployment settings and GitHub. This screen is read-only except for bounded resynchronization.</p></div></div><div className="settings-grid"><section className="settings-card"><h2>GitHub source of truth</h2><dl><dt>Repository</dt><dd>{project?.full_name ?? 'Not configured'}</dd><dt>Project node ID</dt><dd className="mono">{project?.project_node_id ?? 'Not configured'}</dd><dt>Integration branch</dt><dd>{project?.integration_branch ?? 'Unknown'}</dd><dt>Signed-in member</dt><dd>{me.member.login} ({me.member.role})</dd></dl>{project?.legacy_data_warning && <p className="warning">{project.legacy_data_warning}</p>}</section><section className="settings-card"><h2>Synchronization health</h2><dl><dt>Last successful sync</dt><dd>{health?.project?.last_sync ? new Date(health.project.last_sync).toLocaleString() : 'Never'}</dd><dt>Native mode</dt><dd>{health?.native ? 'GitHub Issues + Projects v2' : 'Legacy database (read-only migration warning)'}</dd><dt>Queue</dt><dd>{health?.pending ?? 0} pending · {health?.failed ?? 0} failed</dd><dt>Coverage</dt><dd>{health?.stale ? 'Stale or pending' : 'Current'}</dd></dl>{me.member.role === 'developer' && <button onClick={() => void run(() => request('/api/project/resync', { method: 'POST', body: JSON.stringify({ retry_failed: true }) }), 'GitHub resynchronization queued')} disabled={busy}>Queue resync</button>}</section></div></>;
}

createRoot(document.getElementById('root')!).render(<App />);
