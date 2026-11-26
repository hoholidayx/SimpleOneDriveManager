import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { Store } from '../server/store.js';
import { Graph } from '../server/graph.js';
import type { AuthProvider } from '../server/auth.js';
import { AppError } from '../server/errors.js';
import { FakeDrive } from './fake-drive.js';

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({ lan: [{ address: '192.0.2.20', family: 'IPv4', internal: false }] })
}));

let context: Awaited<ReturnType<typeof createApp>>; let store: Store; let remote: FakeDrive; let headers: Record<string, string>;
let staticRoot: string;
beforeEach(async () => {
  const key = randomBytes(32); store = new Store(':memory:', key); remote = new FakeDrive();
  staticRoot = mkdtempSync(path.join(tmpdir(), 'odm-static-'));
  mkdirSync(path.join(staticRoot, 'dist/client'), { recursive: true });
  writeFileSync(path.join(staticRoot, 'dist/client/index.html'), '<!doctype html><html><title>Test Manager</title></html>');
  const account = { id: 'owner', name: '测试用户', username: 'test@example.com' };
  store.set('account', account);
  const { token, session } = store.newSession('owner');
  headers = { host: 'localhost:3000', cookie: `odm_session=${token}`, 'x-csrf-token': session.csrf, origin: 'http://localhost:3000' };
  const auth: AuthProvider = { configured: true, missing: [], token: async () => 'token', login: async s => { store.saveOAuth('valid-state', s.hash, { verifier: 'verifier', nonce: 'nonce' }); return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=valid-state'; }, callback: async (_code, state, s) => { if (!store.consumeOAuth(state, s.hash)) throw new AppError(400, 'INVALID_STATE', '授权校验失败'); return account; }, clear: async () => store.clearAccount() };
  const config: Config = { root: staticRoot, host: '0.0.0.0', port: 3000, origin: 'http://localhost:3000', redirectUri: 'http://localhost:3000/api/auth/callback', clientId: '', clientSecret: '', tenantId: 'common', encryptionKey: key, databasePath: ':memory:', production: true };
  context = await createApp(config, { store, auth, graph: new Graph(auth, key, remote.fetch), logger: false });
});
afterEach(async () => { await context.app.close(); store.close(); rmSync(staticRoot, { recursive: true, force: true }); });
describe('HTTP boundaries and application flow', () => {
  it('serves the built index document and browser routes', async () => {
    for (const url of ['/', '/workspace']) {
      const result = await context.app.inject({ url, headers });
      expect(result.statusCode).toBe(200); expect(result.body).toContain('Test Manager');
      expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });
  it('blocks untrusted hosts, unauthenticated actions and invalid CSRF', async () => {
    expect((await context.app.inject({ url: '/health', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
    expect((await context.app.inject({ url: '/api/drive', headers: { host: 'localhost' } })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: '/api/items/root/folders', payload: { name: 'test' }, headers: { ...headers, 'x-csrf-token': 'invalid' } })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'POST', url: '/api/items/root/folders', payload: { name: 'test' }, headers: { ...headers, origin: 'https://attacker.example' } })).statusCode).toBe(403);
    expect(remote.requests).toHaveLength(0);
  });
  it('accepts LAN access and same-origin writes while retaining authentication and CSRF', async () => {
    const lanHeaders = { ...headers, host: '192.0.2.20:3000', origin: 'http://192.0.2.20:3000' };
    expect((await context.app.inject({ url: '/', headers: lanHeaders })).statusCode).toBe(200);
    expect((await context.app.inject({ url: '/api/drive', headers: { host: lanHeaders.host } })).statusCode).toBe(401);
    const create = { method: 'POST' as const, url: '/api/items/root/folders', payload: { name: 'LAN folder' } };
    expect((await context.app.inject({ ...create, headers: { ...lanHeaders, 'x-csrf-token': 'invalid' } })).statusCode).toBe(403);
    expect((await context.app.inject({ ...create, headers: { ...lanHeaders, origin: 'http://attacker.example' } })).statusCode).toBe(403);
    expect((await context.app.inject({ ...create, headers: lanHeaders })).statusCode).toBe(200);
    expect((await context.app.inject({ url: '/health', headers: { host: '192.0.2.99:3000' } })).statusCode).toBe(403);
  });
  it('explains a localhost callback mismatch to a LAN browser before starting OAuth', async () => {
    const lanHeaders = { host: '192.0.2.20:3000' };
    const status = await context.app.inject({ url: '/api/auth/status', headers: lanHeaders });
    expect(status.json().loginIssue).toContain('HTTPS');
    const login = await context.app.inject({ url: '/api/auth/login', headers: lanHeaders });
    expect(login.statusCode).toBe(400);
    expect(login.json().error.code).toBe('CALLBACK_HOST_MISMATCH');
  });
  it('does not expose credentials or runtime files through static path aliases', async () => {
    writeFileSync(path.join(staticRoot, '.env'), 'PRIVATE_TEST_VALUE');
    mkdirSync(path.join(staticRoot, '.runtime'));
    writeFileSync(path.join(staticRoot, '.runtime/app.sqlite'), 'PRIVATE_TEST_VALUE');
    for (const url of ['/.env', '/../../.env', '/%2e%2e/%2e%2e/.env', '//.env', '/assets/../../../.runtime/app.sqlite']) {
      const result = await context.app.inject({ url, headers });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toContain('PRIVATE_TEST_VALUE');
    }
  });
  it('rotates the session at OAuth callback and rejects replayed state', async () => {
    const login = await context.app.inject({ url: '/api/auth/login', headers });
    expect(login.statusCode).toBe(302);
    const callback = await context.app.inject({ url: '/api/auth/callback?code=code&state=valid-state', headers });
    expect(callback.headers.location).toBe('http://localhost:3000');
    expect(callback.cookies[0].httpOnly).toBe(true);
    expect(callback.cookies[0].value).not.toBe(headers.cookie.split('=')[1]);
    expect(store.getSession(headers.cookie.split('=')[1])).toBeNull();
    const nextCookie = `odm_session=${callback.cookies[0].value}`;
    const replay = await context.app.inject({ url: '/api/auth/callback?code=code&state=valid-state', headers: { ...headers, cookie: nextCookie } });
    expect(replay.headers.location).toContain('authError=');
  });
  it('serves directory CRUD and downloads original bytes', async () => {
    const result = await context.app.inject({ method: 'POST', url: '/api/items/root/folders', headers, payload: { name: '新目录' } });
    expect(result.statusCode).toBe(200); const folder = result.json();
    const rename = await context.app.inject({ method: 'PATCH', url: `/api/items/${folder.id}`, headers, payload: { name: '重命名目录', eTag: folder.eTag } });
    expect(rename.json().name).toBe('重命名目录');
    const children = await context.app.inject({ url: '/api/items/root/children', headers });
    expect(children.json().items.some((i: { name: string }) => i.name === '重命名目录')).toBe(true);
    const download = await context.app.inject({ url: '/api/items/note/download', headers });
    expect(download.rawPayload).toEqual(Buffer.from('你好，OneDrive'));
    expect(download.headers['content-disposition']).toContain('filename*=UTF-8');
    const remove = await context.app.inject({ method: 'DELETE', url: `/api/items/${folder.id}`, headers }); expect(remove.statusCode).toBe(204);
  });
  it('uploads bytes through authenticated tasks and returns safe task metadata', async () => {
    const create = await context.app.inject({ method: 'POST', url: '/api/uploads', headers, payload: { name: 'api.txt', size: 4, parentId: 'root', lastModified: 1 } });
    expect(create.statusCode).toBe(200);
    const task = create.json();
    const write = await context.app.inject({ method: 'PUT', url: `/api/uploads/${task.id}/content`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('test') });
    expect(write.json().state).toBe('completed');
    const list = await context.app.inject({ url: '/api/uploads', headers });
    expect(list.json().tasks[0]).not.toHaveProperty('uploadUrl');
    expect(list.json().tasks[0]).not.toHaveProperty('owner');
    const empty = await context.app.inject({ method: 'POST', url: '/api/uploads', headers, payload: { name: 'empty-api.txt', size: 0, parentId: 'root', lastModified: 1 } });
    const emptyWrite = await context.app.inject({ method: 'PUT', url: `/api/uploads/${empty.json().id}/content`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(0) });
    expect(emptyWrite.statusCode).toBe(200); expect(emptyWrite.json().state).toBe('completed');
    const logout = await context.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(logout.statusCode).toBe(200);
    expect((await context.app.inject({ url: '/api/drive', headers })).statusCode).toBe(401);
  });
  it('does not reuse the compressed length for an automatically decoded download', async () => {
    const fetcher = remote.fetch;
    const bytes = Buffer.from('下载内容经过自动解压后长度已经变化');
    context.graph.fetcher = async (input, init) => String(input).includes('/download/')
      ? new Response(new Uint8Array(bytes), { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '8' } })
      : fetcher(input, init);
    const download = await context.app.inject({ url: '/api/items/note/download', headers });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    expect(download.headers['content-length']).not.toBe('8');
    expect(download.headers['content-encoding']).toBeUndefined();
  });
  it('loads thumbnails independently and only reads original content on the original route', async () => {
    remote.saveImage('root', '图片.svg', 'picture');
    for (const size of ['medium', 'large'] as const) {
      const res = await context.app.inject({ url: `/api/items/picture/thumbnail?size=${size}`, headers });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(remote.thumbnails.get('picture')![size]);
      expect(res.headers['content-type']).toContain('image/svg+xml');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(remote.requests.some(req => new URL(req.url).pathname.endsWith('/content') || req.url.includes('/download/'))).toBe(false);
    const original = await context.app.inject({ url: '/api/items/picture/original', headers });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload).toEqual(remote.content.get('picture'));
    expect(original.headers['content-disposition']).toBe('attachment');
    expect(original.headers['content-security-policy']).toContain('sandbox');
    const storage = remote.requests.filter(req => !req.url.startsWith('https://graph.microsoft.com/'));
    expect(storage.length).toBe(3);
    for (const req of storage) expect(new Headers(req.init?.headers).has('Authorization')).toBe(false);
  });
  it('rejects unauthorized, invalid and non-image previews without reading file bytes', async () => {
    remote.saveImage('root', '未生成.svg', 'missing', { noThumbnail: true });
    for (const suffix of ['thumbnail?size=medium', 'original']) {
      expect((await context.app.inject({ url: `/api/items/missing/${suffix}`, headers: { host: 'localhost' } })).statusCode).toBe(401);
      expect((await context.app.inject({ url: `/api/items/note/${suffix}`, headers })).json().error.code).toBe('NOT_IMAGE');
      expect((await context.app.inject({ url: `/api/items/root/${suffix}`, headers })).json().error.code).toBe('NOT_IMAGE');
    }
    for (const query of ['', '?size=small', '?size=c1200x1200']) expect((await context.app.inject({ url: `/api/items/missing/thumbnail${query}`, headers })).statusCode).toBe(400);
    const missing = await context.app.inject({ url: '/api/items/missing/thumbnail?size=large', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NO_THUMBNAIL');
    expect(remote.requests.every(req => !req.url.includes('/content') && !req.url.includes('/download/'))).toBe(true);
  });
  it('rejects invalid thumbnail content without downloading the original', async () => {
    remote.saveImage('root', '图片.svg', 'picture');
    const fetcher = remote.fetch;
    context.graph.fetcher = async (input, init) => String(input).includes('test-mediap.svc.ms') ? new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }) : fetcher(input, init);
    const result = await context.app.inject({ url: '/api/items/picture/thumbnail?size=large', headers });
    expect(result.statusCode).toBe(502);
    expect(result.json().error.code).toBe('INVALID_IMAGE_CONTENT');
    expect(remote.requests.every(req => !req.url.includes('/content'))).toBe(true);
  });
});
