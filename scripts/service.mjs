import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const runtime = path.join(root, '.runtime');
const recordPath = path.join(runtime, 'service.json');
const lockPath = path.join(runtime, 'service.lock');
const entry = path.join(root, 'dist/server/server/index.js');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST === 'localhost' ? '127.0.0.1' : process.env.HOST || '0.0.0.0';
const healthHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
const urlFor = (address, portNumber) => `http://${isIP(address) === 6 ? `[${address}]` : address}:${portNumber}`;
const healthUrl = `${urlFor(healthHost, port)}/health`;
function addresses() {
  const result = new Set([healthHost]);
  if (host === '0.0.0.0' || host === '::') for (const info of Object.values(networkInterfaces()).flat()) {
    if (info && !info.internal && !info.address.includes('%') && (host === '::' || info.family === 'IPv4')) result.add(info.address);
  }
  return [...result].map(address => urlFor(address, port));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(runtime, { recursive: true, mode: 0o700 });
chmodSync(runtime, 0o700);

function info(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!started || !command || command.includes('<defunct>')) return null;
    return { started, command };
  } catch { return null; }
}
function readRecord() {
  if (!existsSync(recordPath)) return null;
  try { return JSON.parse(readFileSync(recordPath, 'utf8')); } catch { throw new Error('运行记录损坏，请检查 .runtime/service.json；为避免误操作，未发送任何停止信号。'); }
}
function verify(record) {
  const current = info(record.pid);
  if (!current) return null;
  if (record.root !== root || record.entry !== entry || current.started !== record.processStarted || current.command !== record.processCommand || !current.command.includes(entry)) {
    throw new Error(`PID ${record.pid} 与本项目运行记录不匹配，拒绝停止或重启该进程。`);
  }
  return current;
}
function listeners(portNumber) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${portNumber}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).map(Number);
  } catch (e) {
    if (e.status === 1) return [];
    throw new Error('无法通过 lsof 核对监听端口，请安装 lsof 后重试。');
  }
}
async function health(record) {
  try {
    const response = await fetch(record.healthUrl || `http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    return response.ok && data.service === 'simple-onedrive-manager' && data.instanceId === record.instanceId && data.pid === record.pid;
  } catch { return false; }
}
async function freePort() {
  // 部分系统允许不同网卡上的监听重叠；先核对全部监听者，防止通配地址掩盖占用。
  const occupied = () => new Error(`端口 ${port} 已被占用，请在 .env 中修改 PORT、APP_ORIGIN 和 MS_REDIRECT_URI。本脚本不会停止占用端口的其他程序。`);
  if (listeners(port).length) throw occupied();
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? occupied() : new Error(`无法监听 ${host}:${port}（${error.code}），请确认 HOST 是本机可用地址。`)));
    server.listen(port, host, () => server.close(resolve));
  });
}
async function start() {
  const old = readRecord();
  if (old && verify(old)) {
    if (await health(old)) { console.log(`服务已运行：${old.urls?.[0] || `http://localhost:${old.port}`}（PID ${old.pid}）`); return; }
    throw new Error('本项目进程仍在运行，但健康检查失败。请先查看日志或执行 npm stop。');
  }
  if (!existsSync(entry)) throw new Error('尚未构建项目，请先运行 npm run build。');
  await freePort();
  const instanceId = randomUUID();
  const stdout = path.join(runtime, 'stdout.log');
  const stderr = path.join(runtime, 'stderr.log');
  const out = openSync(stdout, 'a', 0o600);
  const err = openSync(stderr, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entry], { cwd: root, detached: true, stdio: ['ignore', out, err], env: { ...process.env, NODE_ENV: 'production', ODM_INSTANCE_ID: instanceId } });
  } finally { closeSync(out); closeSync(err); }
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const current = info(child.pid);
  if (!current) throw new Error(`服务未能启动，请查看 ${stderr}`);
  const record = { pid: child.pid, host, port, healthUrl, urls: addresses(), root, entry, instanceId, launchedAt: new Date().toISOString(), processStarted: current.started, processCommand: current.command, executable: process.execPath, args: [entry], stdout, stderr };
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!verify(record)) break;
    const owners = listeners(port);
    if (await health(record) && owners.includes(record.pid) && owners.every(pid => pid === record.pid)) {
      console.log(`已在后台启动，监听 ${host}:${port}\n访问地址：\n${record.urls.join('\n')}\nPID：${record.pid}\n日志：${stdout}\n错误日志：${stderr}`);
      return;
    }
    await sleep(250);
  }
  if (verify(record)) process.kill(record.pid, 'SIGTERM');
  throw new Error(`服务健康检查未通过，请查看 ${stderr} 和 ${stdout}`);
}
async function stop() {
  const record = readRecord();
  if (!record) { console.log('服务未运行。'); return; }
  if (!verify(record)) { rmSync(recordPath, { force: true }); console.log('进程已退出，已清理旧运行记录。'); return; }
  const owners = listeners(record.port);
  if (owners.some(pid => pid !== record.pid)) throw new Error('端口现在由其他进程监听，拒绝停止或重启。请检查运行记录。');
  // 每次发信号前重新核对进程启动时间与完整命令，绝不根据端口号结束进程。
  verify(record);
  process.kill(record.pid, 'SIGTERM');
  for (let n = 0; n < 70; n++) {
    if (!info(record.pid)) { rmSync(recordPath, { force: true }); console.log('服务已停止。'); return; }
    // After the verified SIGTERM, only wait; ps can report a transitional command
    // during exit. No further signals are sent, including if the PID is reused.
    await sleep(250);
  }
  throw new Error('进程尚未正常退出。为避免中断任务，未强制结束；请查看日志。');
}
async function status() {
  const record = readRecord();
  if (!record || !verify(record)) { console.log('服务未运行。'); return; }
  const healthy = await health(record);
  const listening = listeners(record.port).includes(record.pid);
  console.log(`${healthy && listening ? '运行正常' : '运行异常'}：${record.healthUrl || `http://localhost:${record.port}`}\n监听地址：${record.host || '127.0.0.1'}:${record.port}\n访问地址：\n${(record.urls || [`http://localhost:${record.port}`]).join('\n')}\nPID：${record.pid}\n启动时间：${record.processStarted}\n监听端口：${listening ? '正常' : '未监听'}\n健康检查：${healthy ? '通过' : '失败'}\n日志：${record.stdout}\n错误日志：${record.stderr}`);
  if (!healthy || !listening) process.exitCode = 1;
}
let locked = false;
try {
  const action = process.argv[2];
  if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('用法：node scripts/service.mjs start|stop|restart|status');
  if (['start', 'restart'].includes(action) && !isIP(host)) throw new Error('HOST 必须是监听 IP，例如 0.0.0.0 或 127.0.0.1');
  if (action !== 'status') {
    try { mkdirSync(lockPath); }
    catch {
      let prior;
      try { prior = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); } catch { throw new Error('启停操作锁尚未释放，请稍后重试。'); }
      const current = info(prior.pid);
      if (current && current.started === prior.started && current.command === prior.command) throw new Error('另一个启停操作正在进行，请稍后重试。');
      rmSync(lockPath, { recursive: true });
      mkdirSync(lockPath);
    }
    locked = true;
    writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, ...info(process.pid) }), { mode: 0o600 });
  }
  if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else if (action === 'restart') { await stop(); await start(); }
  else await status();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { if (locked) rmSync(lockPath, { recursive: true, force: true }); }
