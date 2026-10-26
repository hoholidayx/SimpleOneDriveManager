import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
const protectedPath = /(?:^|\/)(?:\.env(?:\..*)?|\.runtime|node_modules|dist|\.ssh|\.npmrc|\.netrc|\.envrc)(?:\/|$)|\.(?:env(?:\..*)?|log|sqlite(?:-[a-z]+)?|db(?:-[a-z]+)?|pem|key|p12|pfx|keystore)$/i;
const patterns = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{50,255})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['JWT token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/]
];
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const privateValues = ['MS_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'MS_CLIENT_ID']
  .map(name => [name, process.env[name]]).filter(([, value]) => value && value.length >= 12);

function inspect(name, bytes, build = false) {
  const text = bytes.toString('utf8');
  if (bytes.includes(0)) return;
  for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(`${name}: possible ${label}`);
  for (const [label, value] of privateValues) if (text.includes(value)) findings.push(`${name}: contains local ${label}`);
  if (!build && (text.includes(root) || text.includes(`${homedir()}/`))) findings.push(`${name}: contains a local filesystem path`);
  if (name === '.env.example' && /^(?:MS_CLIENT_ID|MS_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY)=\S+/m.test(text)) findings.push(`${name}: example credential must be empty`);
}
for (const name of tracked) {
  if (name !== '.env.example' && protectedPath.test(name)) findings.push(`${name}: private/runtime file is tracked`);
  // Scan the actual index snapshot that will become the commit, not an unstaged replacement.
  inspect(name, execFileSync('git', ['show', `:${name}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
}
let buildCount = 0;
function inspectBuild(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspectBuild(file);
    else if (entry.isFile()) { inspect(path.relative(root, file), readFileSync(file), true); buildCount++; }
  }
}
if (process.argv.includes('--include-build')) inspectBuild(path.join(root, 'dist/client'));
if (!tracked.length) findings.push('No tracked files; stage the intended publication before scanning.');
if (findings.length) {
  // Report only file names and categories. Never print matched secret values.
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else console.log(`Secret check passed: ${tracked.length} staged files${buildCount ? ` and ${buildCount} browser assets` : ''}; no local credentials or private files detected.`);
