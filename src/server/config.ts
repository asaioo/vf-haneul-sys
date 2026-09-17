import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  demo: boolean;
  production: boolean;
  host: string;
  port: number;
  origin: string;
  dbPath: string;
  encryptionKey: Buffer;
  webhookSecret: string;
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  repoId: string;
  installationId: string;
  projectNodeId: string;
  bootstrapIds: string[];
  prefix: string;
  governanceEnabled?: boolean;
  governanceModelApiKey?: string;
  governanceModelBaseUrl?: string;
  governanceModel?: string;
  governanceModelDisableThinking?: boolean;
  governancePrivateCodeOptIn?: boolean;
}

export function config(env = process.env, demo = process.argv.includes('--demo')): Config {
  const production = env.NODE_ENV === 'production';
  if (demo && production) throw new Error('Demo is impossible in production');
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const flag = (key: string, fallback = false) => {
    const value = env[key];
    if (value === undefined || value === '') return fallback;
    if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
    return value === 'true';
  };
  const host = demo ? '127.0.0.1' : env.HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origin = demo ? `http://127.0.0.1:${port}` : required('APP_ORIGIN');
  const url = new URL(origin);
  if (!demo && (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash)) {
    throw new Error('APP_ORIGIN must be an HTTPS origin');
  }
  const key = demo ? Buffer.alloc(32, 42) : Buffer.from(required('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must encode 32 bytes');
  // The demo is deliberately a new filename. Existing data/demo.sqlite is legacy
  // local-PM data and must not be silently reinterpreted as GitHub data.
  const dbPath = demo ? resolve('data/github-demo.sqlite') : resolve(required('DATABASE_PATH'));
  if (!demo && dbPath === resolve('data/demo.sqlite')) throw new Error('Production cannot use demo database');
  const projectNodeId = demo ? (env.GITHUB_PROJECT_NODE_ID ?? '') : required('GITHUB_PROJECT_NODE_ID');
  if (projectNodeId && !/^[A-Za-z0-9_:-]{3,200}$/.test(projectNodeId)) throw new Error('Invalid GITHUB_PROJECT_NODE_ID');
  const governanceModelBaseUrl = env.GOVERNANCE_MODEL_BASE_URL ?? 'https://api.openai.com/v1';
  const modelUrl = new URL(governanceModelBaseUrl);
  if (!['http:', 'https:'].includes(modelUrl.protocol) || modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash) throw new Error('Invalid GOVERNANCE_MODEL_BASE_URL');
  const c: Config = {
    demo,
    production,
    host,
    port,
    origin: new URL(origin).origin,
    dbPath,
    encryptionKey: key,
    webhookSecret: demo ? 'isolated-demo-webhook-not-production' : required('GITHUB_WEBHOOK_SECRET'),
    appId: demo ? '0' : required('GITHUB_APP_ID'),
    privateKey: demo ? '' : readFileSync(required('GITHUB_PRIVATE_KEY_PATH'), 'utf8'),
    clientId: demo ? '' : required('GITHUB_CLIENT_ID'),
    clientSecret: demo ? '' : required('GITHUB_CLIENT_SECRET'),
    repoId: demo ? '101' : required('GITHUB_REPOSITORY_ID'),
    installationId: demo ? '201' : required('GITHUB_INSTALLATION_ID'),
    projectNodeId,
    bootstrapIds: (demo ? '1' : required('BOOTSTRAP_GITHUB_IDS')).split(',').map(v => v.trim()).filter(Boolean),
    prefix: env.TASK_PREFIX ?? 'TASK',
    governanceEnabled: flag('GOVERNANCE_ENABLED', flag('GOVERNANCE_MODEL_ENABLED', false)),
    governanceModelApiKey: env.GOVERNANCE_MODEL_API_KEY ?? env.OPENAI_API_KEY ?? '',
    governanceModelBaseUrl: governanceModelBaseUrl.replace(/\/$/, ''),
    governanceModel: env.GOVERNANCE_MODEL ?? env.OPENAI_MODEL ?? '',
    governanceModelDisableThinking: flag('GOVERNANCE_MODEL_DISABLE_THINKING', false),
    governancePrivateCodeOptIn: flag('GOVERNANCE_PRIVATE_CODE_OPT_IN', false),
  };
  if (!/^[A-Z][A-Z0-9]{1,15}$/.test(c.prefix)) throw new Error('Invalid TASK_PREFIX');
  if (!demo && c.webhookSecret.length < 32) throw new Error('Webhook secret must be at least 32 characters');
  if (![c.repoId, c.installationId, c.appId, ...c.bootstrapIds].every(v => /^\d+$/.test(v))) throw new Error('GitHub identities must be numeric IDs');
  return c;
}
