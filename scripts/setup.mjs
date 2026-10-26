import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (!existsSync(envFile)) {
  const template = readFileSync(path.join(root, '.env.example'), 'utf8');
  writeFileSync(envFile, template.replace('TOKEN_ENCRYPTION_KEY=\n', `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`), { mode: 0o600, flag: 'wx' });
  console.log('已创建本机 .env 和授权缓存加密密钥。请填写 MS_CLIENT_ID、MS_CLIENT_SECRET。');
} else {
  const original = readFileSync(envFile, 'utf8');
  const line = /^TOKEN_ENCRYPTION_KEY=([^\r\n]*)$/m.exec(original);
  if (!line || !line[1].trim()) {
    const keyLine = `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`;
    const contents = line ? original.replace(/^TOKEN_ENCRYPTION_KEY=[^\r\n]*$/m, keyLine) : `${original.trimEnd()}\n${keyLine}\n`;
    writeFileSync(envFile, contents, { mode: 0o600 });
    console.log('已生成本机授权缓存加密密钥。');
  }
  chmodSync(envFile, 0o600);
}
