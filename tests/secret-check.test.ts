import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const script = path.join(process.cwd(), 'scripts/check-secrets.mjs');
const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'odm-secret-check-'));
  directories.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}
function run(root: string) {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}
afterEach(() => directories.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
describe('publication secret checks', () => {
  it('accepts an empty credential example with ordinary source files', () => {
    const root = fixture();
    writeFileSync(path.join(root, '.env.example'), 'MS_CLIENT_ID=\nMS_CLIENT_SECRET=\nTOKEN_ENCRYPTION_KEY=\n');
    writeFileSync(path.join(root, 'app.ts'), 'export const ready = true;');
    execFileSync('git', ['add', '.'], { cwd: root });
    expect(run(root).status).toBe(0);
  });
  it('rejects private tracked configuration without displaying its value', () => {
    const root = fixture(); const value = 'test-only-' + 'x'.repeat(40);
    writeFileSync(path.join(root, '.env'), `MS_CLIENT_SECRET=${value}\n`);
    execFileSync('git', ['add', '.env'], { cwd: root });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('private/runtime file is tracked');
    expect(result.output).not.toContain(value);
  });
  it('scans staged bytes even when the working copy has already removed a token', () => {
    const root = fixture(); const token = 'ghp_' + 'A'.repeat(40);
    writeFileSync(path.join(root, 'leak.txt'), token);
    execFileSync('git', ['add', 'leak.txt'], { cwd: root });
    writeFileSync(path.join(root, 'leak.txt'), 'removed in working tree only');
    const result = run(root);
    expect(result.status).toBe(1); expect(result.output).toContain('possible GitHub token');
    expect(result.output).not.toContain(token);
  });
});
