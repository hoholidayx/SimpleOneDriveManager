// Isolated test service; reuse the same PID, port and process-ownership checks as production.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, '.runtime/browser-check');
const port = Number(process.env.ODM_BROWSER_TEST_PORT || 3101);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ODM_BROWSER_TEST_PORT 必须是 1024–65535 的端口号');
mkdirSync(path.join(root, 'scripts'), { recursive: true });
mkdirSync(path.join(root, 'dist/server/server'), { recursive: true });
for (const file of ['setup.mjs', 'service.mjs']) copyFileSync(path.join(project, 'scripts', file), path.join(root, 'scripts', file));
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(path.join(root, '.env'), `HOST=127.0.0.1\nPORT=${port}\nODM_BROWSER_TEST_PORT=${port}\nTOKEN_ENCRYPTION_KEY=test-only\n`, { mode: 0o600 });
writeFileSync(path.join(root, 'dist/server/server/index.js'), `import { tsImport } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};\nawait tsImport(${JSON.stringify(pathToFileURL(path.join(project, 'tests/browser-fixture.ts')).href)}, import.meta.url);\n`);
const child = spawn(process.execPath, [path.join(root, 'scripts/service.mjs'), process.argv[2] || 'status'], { cwd: root, stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ODM_BROWSER_TEST_PORT: String(port) } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
