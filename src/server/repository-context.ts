import type { ContextSnapshot, RepositoryContextDocument } from '../shared/types.js';
import { governancePathExcluded } from './github.js';

const MAX_CONTEXT_MARKDOWN = 48_000;
const MAX_DOCUMENT_TEXT = 20_000;

function counts(values: string[]) {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result].sort(([a], [b]) => a.localeCompare(b));
}

/** Deterministic whole-tree map. It is derived context, never repository authority. */
export function buildRepositoryContext(snapshot: ContextSnapshot, repoId: string, previous?: RepositoryContextDocument): RepositoryContextDocument {
  if (snapshot.truncated || snapshot.codebase_complete !== true) throw new Error('Repository codebase snapshot is incomplete; context cannot be generated');
  const blobs = snapshot.inventory.filter(entry => entry.type === 'blob' && !governancePathExcluded(entry.path)).map(entry => entry.path).sort();
  const directories = counts(blobs.map(path => path.includes('/') ? path.split('/')[0] : '(root)'));
  const extensions = counts(blobs.map(path => {
    const name = path.split('/').at(-1) ?? path;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
  }));
  const lines = [
    '# Repository context',
    '',
    `Baseline SHA: ${snapshot.sha}`,
    `Files: ${blobs.length}`,
    '',
    '## Top-level inventory',
    ...directories.map(([name, count]) => `- ${name}: ${count}`),
    '',
    '## File types',
    ...extensions.map(([name, count]) => `- ${name}: ${count}`),
    '',
    '## Manifests',
    ...(snapshot.manifests.length ? [...snapshot.manifests].sort().map(path => `- ${path}`) : ['- None']),
    '',
    '## Scoped policies',
    ...(snapshot.scoped_policies.length ? [...snapshot.scoped_policies].sort().map(path => `- ${path}`) : ['- None']),
    '',
    '## Files',
    ...blobs.map(path => `- ${path}`),
  ];
  let documentBytes = 0;
  for (const [path, document] of Object.entries(snapshot.documents).sort(([a], [b]) => a.localeCompare(b))) {
    if (!document.content || path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) continue;
    const remaining = MAX_DOCUMENT_TEXT - documentBytes;
    if (remaining <= 0) break;
    const content = document.content.slice(0, remaining);
    documentBytes += content.length;
    lines.push('', `## ${path}`, '', content);
  }
  const markdown = `${lines.join('\n').slice(0, MAX_CONTEXT_MARKDOWN)}\n`;
  const now = Date.now();
  return {
    id: `repository:${repoId}`,
    repo_id: repoId,
    baseline_sha: snapshot.sha,
    markdown,
    user_note: previous?.user_note ?? '',
    revision: (previous?.revision ?? 0) + 1,
    generated_at: now,
    updated_at: now,
  };
}
