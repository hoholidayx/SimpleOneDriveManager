// 仅用于浏览器验收：显式依赖注入内存网盘，不加载生产配置或访问微软服务。
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { Graph } from '../server/graph.js';
import type { AuthProvider } from '../server/auth.js';
import type { Config } from '../server/config.js';
import { FakeDrive } from './fake-drive.js';

const port = Number(process.env.ODM_BROWSER_TEST_PORT || 3101);
const key = randomBytes(32);
const store = new Store(':memory:', key);
const account = { id: 'browser-test', name: '测试账号（模拟 OneDrive）', username: 'browser-test@example.com' };
const second = { id: 'browser-second', name: '第二账号（模拟 OneDrive）', username: 'second@example.com' };
store.saveAccount(account);
const auth: AuthProvider = {
  configured: true, missing: [],
  login: async session => {
    const state = randomUUID(); store.saveOAuth(state, session.hash, { verifier: 'test-only', nonce: 'test-only' });
    return `http://127.0.0.1:${port}/api/auth/callback?code=test-only&state=${state}`;
  },
  callback: async (_code, state, session) => {
    if (!store.consumeOAuth(state, session.hash)) throw new Error('Invalid test OAuth state');
    return second;
  },
  token: async id => `fake-test-token:${id}`, clear: async id => store.removeAccount(id)
};
const remote = new FakeDrive();
remote.saveFile('root', '第一账号专属.txt', Buffer.from('first account'), 'first-only');
const other = new FakeDrive();
other.saveFile('root', '第二账号专属.txt', Buffer.from('second account'), 'second-only');
const fetcher: typeof fetch = (input, init) => new Headers(init?.headers).get('authorization') === `Bearer fake-test-token:${second.id}` || String(input).includes('/download/second-only') ? other.fetch(input, init) : remote.fetch(input, init);
remote.saveFile('root', '季度工作总结.docx', Buffer.from('test-only document'));
remote.saveFile('root', '项目计划.pdf', Buffer.from('test-only PDF'));
remote.saveFile('root', '数据汇总.xlsx', Buffer.from('test-only spreadsheet'));
remote.saveImage('root', '山间日落.svg', 'landscape');
remote.saveImage('root', '没有缩略图的图片.svg', 'no-thumb', { noThumbnail: true });
remote.saveImage('root', '手机照片.heic', 'heic', { undecodable: true });
for (let i = 0; i < 24; i++) remote.saveImage('photos', `照片 ${String(i + 1).padStart(2, '0')} — 用于验证长文件名显示和按需加载.svg`, `photo-${i}`);
const config: Config = { root: fileURLToPath(new URL('..', import.meta.url)), host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}`, redirectUri: `http://127.0.0.1:${port}/api/auth/callback`, clientId: '', clientSecret: '', tenantId: 'common', encryptionKey: key, databasePath: ':memory:', production: true };
const { app } = await createApp(config, { store, auth, graph: new Graph(auth, key, fetcher), instanceId: process.env.ODM_INSTANCE_ID });
app.addHook('onSend', async (req, reply, payload) => {
  if (req.url === '/' && !store.getSession(req.cookies.odm_session || '')) {
    store.saveAccount(account);
    reply.setCookie('odm_session', store.newSession(account.id).token, { path: '/', httpOnly: true, sameSite: 'lax' });
  }
  return payload;
});
process.on('SIGHUP', () => undefined);
process.on('SIGTERM', async () => { await app.close(); store.close(); process.exit(0); });
await app.listen({ host: '127.0.0.1', port });
