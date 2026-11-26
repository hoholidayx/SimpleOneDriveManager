import Fastify, { type FastifyRequest, type FastifyReply, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { Readable } from 'node:stream';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { Store, type Session } from './store.js';
import { MicrosoftAuth, type AuthProvider } from './auth.js';
import { Graph, itemPath } from './graph.js';
import { Files } from './files.js';
import { Uploads, publicTask } from './uploads.js';
import { AppError, assert } from './errors.js';
import { CHUNK_SIZE } from '../shared/types.js';
import { imageMime, type ThumbnailSize } from '../shared/images.js';
import { allowedHostnames, loginIssue, requestHostname } from './network.js';

declare module 'fastify' { interface FastifyRequest { session: Session | null } }
const string = { type: 'string', minLength: 1, maxLength: 1024 };
const params = { type: 'object', required: ['id'], properties: { id: string }, additionalProperties: false };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = (req: FastifyRequest) => (req.params as { id: string }).id;
const owner = (req: FastifyRequest) => req.session!.accountId!;
export interface Dependencies { store?: Store; auth?: AuthProvider; graph?: Graph; logger?: boolean; instanceId?: string }

export async function createApp(config: Config, deps: Dependencies = {}) {
  const app = Fastify({ logger: deps.logger === false ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.url', 'res.headers.set-cookie'] }, bodyLimit: CHUNK_SIZE, requestTimeout: 180_000 });
  const store = deps.store || new Store(config.databasePath, config.encryptionKey);
  const auth = deps.auth || new MicrosoftAuth(config, store);
  const graph = deps.graph || new Graph(auth, config.encryptionKey);
  const files = new Files(graph);
  const uploads = new Uploads(graph, store);
  const instanceId = deps.instanceId || randomUUID();
  await app.register(cookie);
  app.decorateRequest('session', null);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_SIZE }, (_req, body, done) => done(null, body));

  function setSession(reply: FastifyReply, accountId: string | null = null) {
    const { token, session } = store.newSession(accountId);
    reply.setCookie('odm_session', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.origin.startsWith('https:'), maxAge: 7 * 86400 });
    return session;
  }
  app.addHook('onRequest', async (req, reply) => {
    const hostname = requestHostname(req.headers.host || '');
    assert(hostname && allowedHostnames(config).has(hostname), 'INVALID_HOST', '请通过本机地址、局域网 IP 或配置的访问域名打开页面', 403);
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (config.production) reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const route = req.url.split('?')[0];
    const isCallback = route === '/api/auth/callback';
    assert(isCallback || req.headers['sec-fetch-site'] !== 'cross-site', 'CROSS_SITE', '请从管理页面发起操作', 403);
    req.session = req.cookies.odm_session ? store.getSession(req.cookies.odm_session) : null;
    if (route === '/api/auth/status' || route === '/api/auth/login') {
      if (!req.session) req.session = setSession(reply);
      return;
    }
    if (isCallback) { assert(req.session, 'INVALID_STATE', '登录会话已过期，请重新连接', 401); return; }
    const account = store.getAccount();
    assert(req.session?.accountId && account?.id === req.session.accountId, 'LOGIN_REQUIRED', '请先连接 OneDrive', 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const supplied = Buffer.from(String(req.headers['x-csrf-token'] || ''));
      const expected = Buffer.from(req.session.csrf);
      assert(supplied.length === expected.length && timingSafeEqual(supplied, expected), 'INVALID_CSRF', '页面校验已失效，请刷新后重试', 403);
      const origin = req.headers.origin;
      const requestOrigin = new URL(`${req.protocol}://${req.headers.host}`).origin;
      const allowed = new Set([requestOrigin, config.origin, new URL(config.redirectUri).origin, ...(!config.production ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [])]);
      assert(!origin || allowed.has(origin), 'INVALID_ORIGIN', '请求来源不正确', 403);
    }
  });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const known = error instanceof AppError;
    const status = known ? error.status : (error.statusCode && error.statusCode < 500 ? error.statusCode : 500);
    const code = known ? error.code : (error.validation ? 'INVALID_INPUT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR');
    const message = known ? error.message : (error.validation ? '输入格式不正确，请检查后重试' : status === 413 ? '单次传输不能超过 10 MiB' : '服务处理失败，请查看本机日志后重试');
    if (!known && status >= 500) req.log.error({ name: error.name, message: error.message, stack: error.stack }, 'request failed');
    if (req.url.split('?')[0] === '/api/auth/callback') return reply.redirect(`${config.origin}/?authError=${encodeURIComponent(message)}`);
    return reply.status(status).send({ error: { code, message, requestId: req.id } });
  });

  app.get('/health', async () => ({ ok: true, service: 'simple-onedrive-manager', instanceId, pid: process.pid }));
  app.get('/api/auth/status', async req => {
    const bound = store.getAccount();
    const connected = !!bound && req.session?.accountId === bound.id;
    return { configured: auth.configured, missing: auth.missing, connected, account: connected ? bound : null, csrfToken: req.session!.csrf, redirectUri: config.redirectUri, origin: config.origin, loginIssue: auth.configured ? loginIssue(config, req.headers.host || '') : undefined };
  });
  app.get('/api/auth/login', async (req, reply) => {
    const issue = auth.configured && loginIssue(config, req.headers.host || '');
    assert(!issue, 'CALLBACK_HOST_MISMATCH', issue || '授权地址配置不正确');
    return reply.redirect(await auth.login(req.session!));
  });
  app.get('/api/auth/callback', { schema: { querystring: object({ code: { type: 'string', minLength: 1, maxLength: 16_384 }, state: string, error: string, error_description: { type: 'string', maxLength: 16_384 } }, ['state']) } }, async (req, reply) => {
    const query = req.query as { code?: string; state: string; error?: string };
    if (query.error) {
      store.consumeOAuth(query.state, req.session!.hash);
      throw new AppError(400, 'AUTH_DENIED', '授权未完成，可以重新连接 OneDrive');
    }
    assert(query.code, 'INVALID_CALLBACK', '授权回调缺少授权码');
    const account = await auth.callback(query.code, query.state, req.session!);
    store.deleteSession(req.session!.hash);
    setSession(reply, account.id);
    return reply.redirect(config.origin);
  });
  app.post('/api/auth/logout', async (req, reply) => {
    assert(!uploads.isActive(), 'UPLOAD_BUSY', '请先暂停正在传输的任务，等待当前分片完成后再退出', 409);
    for (const task of store.uploads(owner(req))) {
      if (!['completed', 'cancelled', 'expired'].includes(task.state)) await uploads.cancel(task.id, owner(req)).catch(() => undefined);
    }
    await auth.clear();
    reply.clearCookie('odm_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/drive', async () => {
    const [drive, root] = await Promise.all([graph.drive(), graph.root()]);
    return { drive, root };
  });
  app.get('/api/items/:id', { schema: { params } }, req => files.details(id(req)));
  app.get('/api/items/:id/children', { schema: { params, querystring: object({ cursor: { type: 'string', maxLength: 16_384 } }) } }, req => graph.children(id(req), owner(req), (req.query as { cursor?: string }).cursor));
  async function imageResponse(req: FastifyRequest, reply: FastifyReply, size?: ThumbnailSize) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once('close', abort);
    try {
      const item = await graph.item(id(req), controller.signal);
      const mime = imageMime(item);
      assert(mime, 'NOT_IMAGE', '此文件不是可预览的图片');
      const res = size ? await graph.thumbnail(item.id, size, controller.signal) : await graph.original(item.id, controller.signal);
      const contentType = size ? res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() : mime;
      if (!contentType || !/^image\/[a-z0-9.+-]+$/.test(contentType)) {
        await res.body?.cancel();
        throw new AppError(502, 'INVALID_IMAGE_CONTENT', 'OneDrive 未返回有效的图片内容');
      }
      assert(res.body, 'EMPTY_IMAGE', '图片响应为空', 502);
      reply.header('Content-Type', contentType);
      // Direct navigation must not turn an uploaded SVG into an executable document.
      reply.header('Content-Disposition', 'attachment');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      const length = res.headers.get('content-length');
      if (length && !res.headers.has('content-encoding')) reply.header('Content-Length', length);
      const stream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    } catch (error) {
      controller.abort();
      reply.raw.removeListener('close', abort);
      throw error;
    }
  }
  app.get('/api/items/:id/thumbnail', { schema: { params, querystring: object({ size: { enum: ['medium', 'large'] } }, ['size']) } }, (req, reply) => imageResponse(req, reply, (req.query as { size: ThumbnailSize }).size));
  app.get('/api/items/:id/original', { schema: { params } }, (req, reply) => imageResponse(req, reply));
  app.post('/api/items/:id/folders', { schema: { params, body: object({ name: string }, ['name']) } }, req => files.createFolder(id(req), (req.body as { name: string }).name));
  app.patch('/api/items/:id', { schema: { params, body: object({ name: string, parentId: string, eTag: string }) } }, req => files.update(id(req), req.body as { name?: string; parentId?: string; eTag?: string }));
  app.delete('/api/items/:id', { schema: { params, querystring: object({ eTag: string }) } }, async (req, reply) => {
    await files.remove(id(req), (req.query as { eTag?: string }).eTag);
    return reply.status(204).send();
  });
  app.get('/api/items/:id/download', { schema: { params } }, async (req, reply) => {
    const item = await graph.item(id(req));
    assert(item.file, 'NOT_FILE', '请选择需要下载的文件');
    let res = await graph.response(`${itemPath(item.id)}/content`);
    if (res.status === 302) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      assert(location, 'NO_DOWNLOAD_URL', '暂时无法获取下载地址', 502);
      res = await graph.storage(location);
    }
    assert(res.body, 'EMPTY_DOWNLOAD', '文件下载响应为空', 502);
    reply.header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`);
    reply.header('Content-Type', 'application/octet-stream');
    const length = res.headers.get('content-length');
    // fetch decodes compressed bodies; their upstream Content-Length is no longer valid.
    if (length && !res.headers.has('content-encoding')) reply.header('Content-Length', length);
    return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
  });
  app.post('/api/batch', { schema: { body: object({ action: { enum: ['move', 'delete'] }, parentId: string, items: { type: 'array', minItems: 1, maxItems: 500, items: object({ id: string, eTag: string }, ['id']) } }, ['action', 'items']) } }, async req => {
    const body = req.body as { action: 'move' | 'delete'; items: { id: string; eTag?: string }[]; parentId?: string };
    assert(body.action !== 'move' || body.parentId, 'INVALID_PARENT', '请选择移动目标');
    return { results: await files.batch(body.action, body.items, body.parentId) };
  });
  app.get('/api/uploads', req => ({ tasks: store.uploads(owner(req)).map(task => publicTask(['pending', 'uploading'].includes(task.state) ? { ...task, state: 'paused' } : task)) }));
  app.post('/api/uploads', { schema: { body: object({ name: string, sourceName: string, size: { type: 'integer', minimum: 0 }, lastModified: { type: 'integer', minimum: 0 }, parentId: string, conflict: { enum: ['fail', 'replace', 'rename'] }, itemId: string, eTag: string }, ['name', 'size', 'lastModified', 'parentId']) } }, req => uploads.create(req.body as Parameters<Uploads['create']>[0], owner(req)));
  app.get('/api/uploads/:id', { schema: { params, querystring: object({ reconcile: { enum: ['1'] } }) } }, req => uploads.status(id(req), owner(req), (req.query as { reconcile?: string }).reconcile === '1'));
  app.put('/api/uploads/:id/content', { schema: { params } }, req => {
    assert(Buffer.isBuffer(req.body), 'INVALID_CONTENT', '请使用二进制方式上传文件内容');
    return uploads.write(id(req), owner(req), req.body, req.headers['content-range'] as string | undefined);
  });
  app.post('/api/uploads/:id/pause', { schema: { params } }, req => uploads.pause(id(req), owner(req)));
  app.delete('/api/uploads/:id', { schema: { params } }, req => uploads.cancel(id(req), owner(req)));

  const clientDir = path.join(config.root, 'dist/client');
  if (existsSync(path.join(clientDir, 'index.html'))) {
    await app.register(staticFiles, { root: clientDir, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      let pathname: string;
      try { pathname = decodeURIComponent(req.url.split('?')[0]); }
      catch { return reply.status(400).send({ error: { code: 'INVALID_PATH', message: '地址格式不正确' } }); }
      const privatePath = pathname.split('/').some(segment => segment.startsWith('.'));
      if (privatePath || pathname.startsWith('/api/') || path.extname(pathname)) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '地址不存在' } });
      return reply.type('text/html').sendFile('index.html');
    });
  } else app.get('/', (_req, reply) => reply.type('text/html').send('<meta charset="utf-8"><p>开发页面：<a href="http://localhost:5173">http://localhost:5173</a>。生产运行请先执行 npm run build。</p>'));
  app.addHook('onClose', async () => { if (!deps.store) store.close(); });
  return { app, store, auth, graph, files, uploads };
}
