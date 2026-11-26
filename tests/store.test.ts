import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe('persistent private state', () => {
  it('persists multiple accounts and browser grants without sharing access between browsers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'odm-accounts-')); dirs.push(dir);
    const file = path.join(dir, 'state.sqlite'); const key = randomBytes(32);
    const store = new Store(file, key);
    for (const id of ['one', 'two']) store.saveAccount({ id, name: id, username: `${id}@example.com` });
    const first = store.newSession('two', ['one', 'two']);
    const second = store.newSession('one');
    store.close();
    expect(readFileSync(file).includes(Buffer.from('two@example.com'))).toBe(false);
    const restored = new Store(file, key);
    expect(restored.getSession(first.token)?.accountId).toBe('two');
    expect(restored.sessionAccounts(first.session.hash).map(a => a.id)).toEqual(['one', 'two']);
    expect(restored.canAccess(second.session.hash, 'two')).toBe(false);
    restored.removeAccount('two');
    expect(restored.getSession(first.token)?.accountId).toBeNull();
    expect(restored.getSession(second.token)?.accountId).toBe('one');
    expect(restored.canAccess(first.session.hash, 'one')).toBe(true);
    restored.close();
  });
  it('encrypts token cache and restores account and sessions after restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'odm-store-')); dirs.push(dir);
    const file = path.join(dir, 'state.sqlite'); const key = randomBytes(32);
    const store = new Store(file, key);
    store.set('msal', 'secret-refresh-token-for-test');
    store.set('account', { id: 'account', name: '测试', username: 'test@example.com' });
    const { token } = store.newSession('account');
    store.close();
    expect(readFileSync(file).includes(Buffer.from('secret-refresh-token-for-test'))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from(token))).toBe(false);
    const restored = new Store(file, key);
    expect(restored.get('msal')).toBe('secret-refresh-token-for-test');
    expect(restored.getSession(token)?.accountId).toBe('account');
    expect(restored.getAccount('account')?.name).toBe('测试');
    expect(restored.sessionAccounts(restored.getSession(token)!.hash).map(a => a.id)).toEqual(['account']);
    expect(restored.get('account')).toBeNull();
    restored.removeAccount('account');
    expect(restored.getAccount('account')).toBeNull(); expect(restored.getSession(token)?.accountId).toBeNull(); restored.close();
  });
  it('binds OAuth state to the requesting browser and consumes it once', () => {
    const store = new Store(':memory:', randomBytes(32));
    store.saveOAuth('state', 'browser-one', { verifier: 'pkce', nonce: 'nonce' });
    expect(store.consumeOAuth('state', 'browser-two')).toBeNull();
    expect(store.consumeOAuth('state', 'browser-one')).toEqual({ verifier: 'pkce', nonce: 'nonce' });
    expect(store.consumeOAuth('state', 'browser-one')).toBeNull(); store.close();
  });
  it('refuses to decrypt a cache using a different key', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'odm-key-')); dirs.push(dir);
    const file = path.join(dir, 'state.sqlite');
    const first = new Store(file, randomBytes(32)); first.set('msal', 'sensitive'); first.close();
    const changed = new Store(file, randomBytes(32)); expect(() => changed.get('msal')).toThrow(); changed.close();
  });
});
