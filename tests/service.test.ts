import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const fixtures: string[] = [];
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return result;
}
function fixture(portNumber: number, changeTitleOnExit = false, startDelay = 0, host = '0.0.0.0') {
  const root = mkdtempSync(path.join(tmpdir(), 'odm-service-')); fixtures.push(root);
  mkdirSync(path.join(root, 'scripts')); mkdirSync(path.join(root, 'dist/server/server'), { recursive: true });
  mkdirSync(path.join(root, 'dist/client'), { recursive: true });
  writeFileSync(path.join(root, 'dist/client/index.html'), '<!doctype html><title>Service test</title>');
  copyFileSync(path.join(process.cwd(), 'manage.sh'), path.join(root, 'manage.sh'));
  for (const name of ['setup.mjs', 'service.mjs']) copyFileSync(path.join(process.cwd(), 'scripts', name), path.join(root, 'scripts', name));
  copyFileSync(path.join(process.cwd(), '.env.example'), path.join(root, '.env.example'));
  writeFileSync(path.join(root, '.env'), `HOST=${host}\nPORT=${portNumber}\nTOKEN_ENCRYPTION_KEY=test\n`);
  writeFileSync(path.join(root, 'dist/server/server/index.js'), `const http=require('node:http'); const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,service:'simple-onedrive-manager',instanceId:process.env.ODM_INSTANCE_ID,pid:process.pid}));});process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{${changeTitleOnExit ? "process.title='odm-stopping';" : ''}server.close(()=>setTimeout(()=>process.exit(0),${changeTitleOnExit ? 500 : 0}));});setTimeout(()=>server.listen(Number(process.env.PORT),process.env.HOST||'0.0.0.0'),${startDelay});`);
  return root;
}
// Exercise the public shell entry point from outside the project directory.
const manage = (root: string, action: string) => exec('/bin/sh', [path.join(root, 'manage.sh'), action], { cwd: tmpdir(), timeout: 25_000, env: { PATH: process.env.PATH } });
afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    await manage(root, 'stop').catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
describe('detached service management', () => {
  it('checks an IPv6-only service using its configured listening address', async () => {
    const root = fixture(await port(), false, 0, '::1');
    await manage(root, 'start');
    const record = JSON.parse(readFileSync(path.join(root, '.runtime/service.json'), 'utf8'));
    expect(record.host).toBe('::1');
    expect(record.healthUrl).toMatch(/^http:\/\/\[::1\]:\d+\/health$/);
    expect((await manage(root, 'status')).stdout).toContain('运行正常');
  });
  it('allows a cold start to finish before declaring the service unhealthy', async () => {
    const root = fixture(await port(), false, 11_000);
    await manage(root, 'start');
    expect((await manage(root, 'status')).stdout).toContain('运行正常');
  }, 25_000);
  it('waits for a verified process to exit even if its command changes during shutdown', async () => {
    const root = fixture(await port(), true);
    await manage(root, 'start');
    await manage(root, 'restart');
    expect((await manage(root, 'status')).stdout).toContain('运行正常');
    await manage(root, 'exit');
    expect((await manage(root, 'status')).stdout).toContain('未运行');
  });
  it('survives launcher exit and SIGHUP, supports repeated start, restart and stop', async () => {
    const root = fixture(await port());
    await manage(root, 'start');
    const record = JSON.parse(readFileSync(path.join(root, '.runtime/service.json'), 'utf8'));
    expect((await manage(root, 'start')).stdout).toContain('服务已运行');
    process.kill(record.pid, 'SIGHUP');
    expect((await manage(root, 'status')).stdout).toContain('运行正常');
    await manage(root, 'restart');
    const restarted = JSON.parse(readFileSync(path.join(root, '.runtime/service.json'), 'utf8'));
    expect(restarted.pid).not.toBe(record.pid);
    await manage(root, 'stop');
    expect((await manage(root, 'status')).stdout).toContain('未运行');
  }, 30_000);
  it('refuses a reused or mismatched PID without sending a signal', async () => {
    const root = fixture(await port());
    await manage(root, 'start');
    const file = path.join(root, '.runtime/service.json'); const original = readFileSync(file, 'utf8');
    const record = JSON.parse(original);
    writeFileSync(file, JSON.stringify({ ...record, pid: process.pid, processStarted: 'stale-start' }));
    try { await expect(manage(root, 'stop')).rejects.toMatchObject({ stderr: expect.stringContaining('不匹配') }); }
    finally { writeFileSync(file, original); }
    expect((await manage(root, 'status')).stdout).toContain('运行正常');
  });
  it('refuses occupied ports and leaves the unrelated listener running', async () => {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = fixture((server.address() as { port: number }).port);
    try {
      await expect(manage(root, 'start')).rejects.toMatchObject({ stderr: expect.stringContaining('已被占用') });
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
