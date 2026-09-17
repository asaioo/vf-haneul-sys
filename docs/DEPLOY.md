# Deploy vf-kapo

This branch ships as a two-stage Docker image plus `compose.yaml`. The container binds only to host loopback; terminate HTTPS with a reverse proxy or ingress and forward it to `127.0.0.1:3000`.

## 1. Initialize the checkout

```sh
cp .env.production.example .env.production
mkdir -p secrets
```

## 2. Put credentials in the correct places

Put scalar values in the untracked file `.env.production`:

- `GITHUB_APP_ID`: numeric App ID.
- `GITHUB_INSTALLATION_ID`: numeric installation ID for the selected repository.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: GitHub App OAuth credentials.
- `GITHUB_WEBHOOK_SECRET`: a random webhook secret of at least 32 characters.
- `GITHUB_REPOSITORY_ID`: immutable numeric repository database ID, not `owner/name`.
- `GITHUB_PROJECT_NODE_ID`: Projects v2 node ID.
- `BOOTSTRAP_GITHUB_IDS`: comma-separated numeric GitHub user IDs allowed to bootstrap.
- `TOKEN_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64.
- `GOVERNANCE_MODEL_API_KEY`: model provider API key.
- `GOVERNANCE_MODEL_BASE_URL` and `GOVERNANCE_MODEL`: the OpenAI-compatible endpoint and model ID.
- `GOVERNANCE_AGENT_LOGINS`: optional comma-separated exact Bot logins allowed to add edge-review labels, for example `edge-agent[bot]`.

Generate local secrets without committing them:

```sh
openssl rand -base64 32                         # TOKEN_ENCRYPTION_KEY
openssl rand -hex 32                            # GITHUB_WEBHOOK_SECRET
gh repo view OWNER/REPO --json databaseId       # GITHUB_REPOSITORY_ID
gh api user --jq .id                            # your BOOTSTRAP_GITHUB_IDS entry
```

Save the GitHub App private key at:

```text
secrets/github-app.pem
```

`compose.yaml` mounts it read-only at `/run/secrets/github_app_private_key` and supplies `GITHUB_PRIVATE_KEY_PATH` automatically. Do not put PEM content in `.env.production`.

The repository ignores `.env.production`, `secrets/*.pem`, databases, and build output. Confirm before deployment:

```sh
git status --short
```

## 3. Configure the GitHub App

Set these App URLs:

- Homepage URL: the `APP_ORIGIN` value.
- Callback URL: `${APP_ORIGIN}/auth/github/callback`.
- Webhook URL: `${APP_ORIGIN}/webhooks/github`.
- Webhook secret: the same `GITHUB_WEBHOOK_SECRET` value.

Required repository permissions for the full governance flow:

- Metadata: read
- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Projects: read

Do not grant merge bypass. Protect the default branch and require the desired Human or organization-authorized Agent approval. vf-kapo does not merge.

Subscribe the App to the repository, installation, Issue, pull request, push, create, delete, and comment events used by the synchronization and governance paths. Install it only on the selected repository where possible.

## 4. Start

```sh
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f vf-kapo
```

The SQLite database lives in the named volume `vf-kapo-data`. Back up that volume together with the unchanged `TOKEN_ENCRYPTION_KEY`; encrypted OAuth credentials cannot be restored without it.

## 5. Network boundary

Allow outbound HTTPS to GitHub and the configured model endpoint. GitHub must be able to reach the public HTTPS webhook URL. The provided Compose port is loopback-only, so direct Internet access to port 3000 is not expected.

The deployed Main Agent uses the bounded direct OpenAI-compatible client. It receives no GitHub credential or write tool; strict server code revalidates its structured result and performs the bounded GitHub operation.
