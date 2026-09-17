# GitHub-native server contract

Node 24.11.1+, TypeScript, Fastify 5, React/Vite, and built-in SQLite. One process monitors one selected private repository and one configured GitHub Projects v2 project. Ordinary synchronization has no model or code execution. An explicit opt-in governance request may read bounded evidence and create only a bot-owned branch/root-policy draft PR; it never writes the default branch, changes Project status, merges, or adopts policy before human merge.

## Commands and isolation

```sh
npm ci
npm run typecheck
npm test
npm run build:server
npm run build:client
npm run demo
```

`npm run demo` is an explicit loopback-only FAKE provider. It uses `data/github-demo.sqlite`, never calls GitHub, and has GitHub-shaped Issue/Project/PR observations. Existing `data/demo.sqlite` is legacy data and is never reset or migrated. Production rejects `--demo`, fake providers, and the demo path. Tests own temporary databases/cwds.

## Authorities

| Fact | Authority |
| --- | --- |
| Issue title/body/acceptance criteria, assignees, labels, open/closed state | GitHub Issue |
| Workflow status | The selected GitHub Projects v2 project's native `Status` field |
| PR/commit/branch facts | GitHub REST observations |
| Warnings, cached observations, leases, audit, comment delivery state | vf-kapo SQLite |

The service never projects an independent local task/status value. A missing Project item is an explicit warning. An unset value and an unknown/custom value are retained as `null`/raw text; they are never changed to `Backlog` or `Done`.

Old `/api/tasks` write routes are retained only to return `410` with GitHub guidance when the project is native. Existing local-PM rows are readable for backup/diagnosis but are not reinterpreted. If a configured production database has an unmarked legacy project row, startup refuses it; back it up and use a new database path.

## GitHub App and provider boundary

Production requires `GITHUB_PROJECT_NODE_ID` in addition to the identity/secrets in `.env.example`. The pilot installation token is scoped to the selected repository and requests:

- Metadata: read
- Contents: read
- Pull requests: read
- Issues: write (only for maintained app-owned comments)
- Projects: read

Only the proposal path requests temporary/operation-scoped **Contents: write** and **Pull requests: write** permissions. GitHub token permissions are not path-scoped: deployment must enforce branch protection, required human review, and no App bypass. Request the least privilege available for observer-only deployments.

The collaborator permission lookup accepts GitHub App installation tokens with **Metadata: read** only; `Administration: read` is not required. See the official [App permission matrix](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) and [collaborator permission API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user). GitHub maps maintain to write and triage to read.

There is no PAT fallback and no dual provider backend. User OAuth credentials remain encrypted outside logs; user repository access is revalidated before protected API use. App installation credentials are used for repository/Project synchronization, maintained comments, and (only when explicitly enabled) the dedicated governance branch/draft PR.

The provider:

1. Reads `/repos/{owner}/{repo}/issues` with bounded REST pagination, filters the selected repository, and excludes entries with a `pull_request` property.
2. Queries the configured node through GitHub GraphQL, requiring `__typename === ProjectV2`, a single-select field named exactly `Status`, and complete bounded pagination for both fields and items.
3. Filters Project items to the selected repository and retains Issue/PR content type and the raw Status name or `null`.
4. Treats GraphQL errors, `data.node === null`, missing status field, partial pages, changing/repeated cursors, and invalid identities as synchronization failures. The worker applies no partial snapshot, so the last valid cache and notices survive.
5. Uses fixed `https://api.github.com` destinations and does not follow provider URLs.

A successful snapshot atomically caches `github_issue`, `project_item`, Git changes, and a context snapshot. The worker uses leases, at-least-once jobs, bounded exponential backoff/jitter, and stale/failed health. A failed page never clears valid facts or resolves a warning.

## Canonical Issue references

Passive PR/commit text can identify an imported Issue without local-member enrollment. Accepted same-repository forms are:

- a strict `Task: #123` line (or `Task: owner/repo#123`),
- GitHub closing keywords such as `Fixes #123`, `Closes #123`, or `Resolves #123`,
- `owner/repo#123`, or
- the canonical `https://github.com/owner/repo/issues/123` URL.

The selected repository is checked before association. Foreign qualified refs, unrelated bare `#123` prose, PR URLs, and multiple/unknown references remain Inbox warnings. Passive facts do not grant service mutation authority.

## Durable comments

For an unresolved PR, coordination stores one `github_comment` row and a durable `github_comment` job. The body contains an app-owned marker `<!-- vf-kapo:coordination:<repo-id>:<pr-number> -->` and GitHub-native instructions. Delivery:

- lists comments before POST, recovering a response lost after a successful POST;
- verifies marker and GitHub App bot author before PATCH;
- refuses to edit or duplicate a spoofed human marker;
- skips an unchanged body and updates the maintained comment instead of spamming;
- leaves a visible blocked/failed job for author verification or provider failure;
- ignores its own marked `issue_comment` webhook as new task content, while ordinary webhook/reconciliation remains durable and idempotent.

The PR body and Issue body are attributed GitHub explanations. Everyday completion does not require a separate vf-kapo explanation submission.

## HTTP contract

All `/api/*` routes require an active member and current repository access. Browser mutations require same-origin CSRF plus the session cookie. Agent tokens are hashed, scoped, expiring, and cannot administer membership/configuration or bypass GitHub authority. Lists use bounded `{items,total,limit,offset,next_offset}` pagination.

- `GET /api/issues`, `GET /api/issues/:number`: cached selected-repository Issues plus Project item/status and observed PR references.
- `GET /api/inbox`: exception notices (missing Project membership, unset status, unresolved refs, untracked changes, sync health, comment delivery).
- `GET /api/project/context`: read-only repository snapshot, root context documents, optional Issue/change enrichment, and explicit freshness/warnings.
- `GET /api/project`, `GET /api/health/sync`, `GET /api/metrics`, `GET /api/audit`: identity, health, bounded jobs, and evidence.
- `GET /api/governance`, `/api/governance/:id`: bounded pending/results, diagnostics, and draft proposal links.
- `GET/POST /api/project/onboarding`: human Developer confirmation of immutable repository/installation/project configuration; initial sync is durable/resumable.
- `POST /api/project/resync`: human Developer queues the same bounded reconciliation path.
- `GET /api/changes`, `GET /api/changes/:id`: observed PR/branch/direct-commit evidence.
- `POST /webhooks/github`: verifies raw-body HMAC, delivery identity, installation/repository IDs, size, and durable delivery deduplication before `202`.

`POST/PATCH /api/tasks`, task status/link/completion routes, and local board mutation UI are obsolete in native mode and return an explicit `410`. Project status changes, Issue creation/edit/close, assignee changes, and normal linking happen in GitHub or the user's `gh`/API.

## Security and limits

The service uses secure HttpOnly SameSite cookies outside demo, CSRF, per-user access checks, encrypted OAuth credentials, hashed agent tokens, fixed provider destinations, repository-relative context limits, Markdown/text as untrusted data, a 1 MiB request limit, bounded pages (up to 100 full pages/10,000 entries plus one terminal empty-page check), and no secret logging. Raw webhook payloads and idempotency results expire after seven days. SQLite online backups must retain the encryption key separately and be restored/tested before pilot validation.

## Explicit governance loop

Signed label events create explicit durable Main Agent requests: `kapo:review-task` on an Issue reviews the task before work, `kapo:review-change` on an open PR reviews its pinned commits/files before merge, and `kapo:review-agents` on an Issue whose body is exactly `PR: #123` retains the post-merge policy-learning loop. The worker re-fetches the current subject, label/body/immutable identities, requester authorization, current integration SHA/root `AGENTS.md`, applicable directory-scoped `AGENTS.md` files, and bounded same-repository evidence. Human requesters need current write permission. Bot requesters are accepted only for edge review when their exact login appears in `GOVERNANCE_AGENT_LOGINS`. Arbitrary prose never grants authority, duplicate deliveries do not repeat model calls, and changed evidence fails closed.

Missing, oversized, partial, changed, or stale evidence produces a diagnostic and no proposal. With `GOVERNANCE_ENABLED`, `GOVERNANCE_MODEL_BASE_URL`, an owner-supplied runtime model/API key, and `GOVERNANCE_PRIVATE_CODE_OPT_IN=true`, the OpenAI-compatible client receives bounded evidence after known secret, binary, and generated paths are omitted. Its wire JSON is `{decision:no_change|fix_code|update_rules,rationale,proposed_agents_md_lines}`. For an open PR, `no_change`/`update_rules` creates an App-authored approval and `fix_code` requests changes; the maintained comment retains the full result. A valid additive `update_rules` result may additionally create an exact root-`AGENTS.md` Draft PR. vf-kapo never merges: repository branch protection decides whether an authorized Human or Agent review permits merge. `GOVERNANCE_MODEL_DISABLE_THINKING=true` is available for compatible reasoning servers.

On the first governance request for a pinned integration SHA, the service collects a bounded complete text-code snapshot, then derives a Markdown repository-context document from the full Git tree/file map, source excerpts, manifests, root context documents, and scoped-policy map. A new integration SHA regenerates that document; the current PR patch remains separate projected evidence rather than silently becoming baseline truth. A Human Developer can add or correct an advisory note through `PUT /api/governance/context` using the returned baseline SHA and revision. The context document, user note, policies, and PR diff are all included in the review digest, so concurrent changes invalidate the result.
