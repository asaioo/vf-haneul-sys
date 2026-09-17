import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepositoryContext } from '../src/server/repository-context.js';
import type { ContextSnapshot } from '../src/shared/types.js';

const snapshot: ContextSnapshot = {
  sha: 'a'.repeat(40),
  fetched_at: 1,
  codebase_complete: true,
  documents: { 'package.json': { blob_sha: 'b'.repeat(40), content: '{"scripts":{"test":"node --test"}}', missing: false, truncated: false } },
  inventory: [
    { path: 'package.json', type: 'blob', sha: 'b'.repeat(40) },
    { path: 'src/app.ts', type: 'blob', sha: 'c'.repeat(40) },
    { path: 'src/AGENTS.md', type: 'blob', sha: 'd'.repeat(40) },
  ],
  manifests: ['package.json'],
  scoped_policies: ['src/AGENTS.md'],
  truncated: false,
  warnings: [],
};

test('repository context maps the complete pinned tree and carries explicit human notes', () => {
  const first = buildRepositoryContext(snapshot, '101');
  assert.match(first.markdown, /Baseline SHA: a{40}/);
  assert.match(first.markdown, /src: 2/);
  assert.match(first.markdown, /package\.json/);
  first.user_note = 'Authentication is intentionally external.';
  const next = buildRepositoryContext({ ...snapshot, sha: 'e'.repeat(40) }, '101', first);
  assert.equal(next.user_note, first.user_note);
  assert.equal(next.revision, first.revision + 1);
});

test('repository context refuses a partial inventory', () => {
  assert.throws(() => buildRepositoryContext({ ...snapshot, truncated: true }, '101'), /incomplete/);
});
