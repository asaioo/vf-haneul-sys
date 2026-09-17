import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const cwd = mkdtempSync(resolve(tmpdir(), 'vf-kapo-browser-'));
cpSync(resolve(root, 'dist/client'), resolve(cwd, 'dist/client'), { recursive: true });
const child = spawn(process.execPath, ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'src/server/main.ts'), '--demo'], {
  cwd,
  stdio: 'inherit',
});
let stopping = false;
const cleanup = () => { if (!stopping) { stopping = true; rmSync(cwd, { recursive: true, force: true }); } };
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { child.kill(signal); });
child.on('exit', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
