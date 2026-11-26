import path from 'node:path';
import { existsSync } from 'node:fs';
import { isLoopback, listenHost } from './network.js';

export interface Config {
  root: string; host: string; port: number; origin: string; redirectUri: string;
  clientId: string; clientSecret: string; tenantId: string;
  encryptionKey: Buffer; databasePath: string; production: boolean;
}

export function loadConfig(): Config {
  const root = process.cwd();
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  return parseConfig(process.env, root);
}

export function parseConfig(env: NodeJS.ProcessEnv, root = process.cwd()): Config {
  const host = listenHost(env.HOST || '0.0.0.0');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535 的整数');
  const origin = env.APP_ORIGIN || `http://localhost:${port}`;
  const redirectUri = env.MS_REDIRECT_URI || `${origin}/api/auth/callback`;
  for (const value of [origin, redirectUri]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || ['0.0.0.0', '[::]'].includes(url.hostname) || url.hostname.includes('*') || url.username || url.password || url.search || url.hash) {
      throw new Error('APP_ORIGIN 和 MS_REDIRECT_URI 必须是可访问的 HTTP(S) 地址，不能包含通配符、用户信息、查询或片段');
    }
  }
  if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN 只能包含协议、主机和端口');
  const callback = new URL(redirectUri);
  if (callback.pathname !== '/api/auth/callback') throw new Error('MS_REDIRECT_URI 路径必须是 /api/auth/callback');
  if (callback.protocol !== 'https:' && !isLoopback(callback.hostname)) throw new Error('微软 OAuth 的非 localhost 回调必须使用 HTTPS；局域网页面地址可使用 HTTP');
  const encryptionKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('请运行 npm run setup，TOKEN_ENCRYPTION_KEY 必须是 32 字节的 Base64 密钥');
  const tenantId = env.MS_TENANT_ID || 'common';
  if (!/^(common|consumers|organizations|[a-f0-9-]{36})$/i.test(tenantId)) throw new Error('MS_TENANT_ID 格式不正确');
  return {
    root, host, port, origin, redirectUri, tenantId, encryptionKey,
    clientId: env.MS_CLIENT_ID || '', clientSecret: env.MS_CLIENT_SECRET || '',
    databasePath: path.join(root, '.runtime', 'app.sqlite'), production: env.NODE_ENV === 'production'
  };
}
