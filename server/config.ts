import path from 'node:path';
import { existsSync } from 'node:fs';

export interface Config {
  root: string; port: number; origin: string; redirectUri: string;
  clientId: string; clientSecret: string; tenantId: string;
  encryptionKey: Buffer; databasePath: string; production: boolean;
}

export function loadConfig(): Config {
  const root = process.cwd();
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535 的整数');
  const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  const redirectUri = process.env.MS_REDIRECT_URI || `http://localhost:${port}/api/auth/callback`;
  for (const value of [origin, redirectUri]) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('本机版本的 APP_ORIGIN 和 MS_REDIRECT_URI 必须使用本机地址');
    }
  }
  if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN 只能包含协议、主机和端口');
  const encryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('请运行 npm run setup，TOKEN_ENCRYPTION_KEY 必须是 32 字节的 Base64 密钥');
  const tenantId = process.env.MS_TENANT_ID || 'common';
  if (!/^(common|consumers|organizations|[a-f0-9-]{36})$/i.test(tenantId)) throw new Error('MS_TENANT_ID 格式不正确');
  return {
    root, port, origin, redirectUri, tenantId, encryptionKey,
    clientId: process.env.MS_CLIENT_ID || '', clientSecret: process.env.MS_CLIENT_SECRET || '',
    databasePath: path.join(root, '.runtime', 'app.sqlite'), production: process.env.NODE_ENV === 'production'
  };
}
