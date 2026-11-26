import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Config } from '../server/config.js';
import { Store } from '../server/store.js';
import { MicrosoftAuth } from '../server/auth.js';
import { InteractionRequiredAuthError } from '@azure/msal-node';

const mock = vi.hoisted(() => ({ getAuthCodeUrl: vi.fn(), acquireTokenByCode: vi.fn(), acquireTokenSilent: vi.fn(), getAccountByHomeId: vi.fn(), getAllAccounts: vi.fn(), removeAccount: vi.fn(), config: null as any }));
vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    constructor(config: unknown) { mock.config = config; }
    getAuthCodeUrl = mock.getAuthCodeUrl;
    acquireTokenByCode = mock.acquireTokenByCode;
    acquireTokenSilent = mock.acquireTokenSilent;
    getTokenCache() { return { getAccountByHomeId: mock.getAccountByHomeId, getAllAccounts: mock.getAllAccounts, removeAccount: mock.removeAccount }; }
  },
  CryptoProvider: class { async generatePkceCodes() { return { verifier: 'test-verifier', challenge: 'test-challenge' }; } },
  InteractionRequiredAuthError: class extends Error {}
}));
beforeEach(() => { vi.clearAllMocks(); mock.getAuthCodeUrl.mockResolvedValue('https://login.microsoftonline.com/authorize'); });
function fixture(configured = true) {
  const store = new Store(':memory:', randomBytes(32));
  const config = { clientId: configured ? 'client-id' : '', clientSecret: configured ? 'client-secret' : '', tenantId: 'common', redirectUri: 'http://localhost:3100/api/auth/callback' } as Config;
  return { store, auth: new MicrosoftAuth(config, store) };
}
describe('Microsoft OAuth and token lifecycle', () => {
  it('selects and refreshes the exact requested account and rejects unknown accounts', async () => {
    const { store, auth } = fixture();
    for (const id of ['one', 'two']) store.saveAccount({ id, name: id, username: `${id}@example.com` });
    mock.getAccountByHomeId.mockImplementation(async id => ({ homeAccountId: id }));
    mock.acquireTokenSilent.mockImplementation(async ({ account, forceRefresh }) => ({ accessToken: `${account.homeAccountId}:${forceRefresh}` }));
    expect(await Promise.all([auth.token('one'), auth.token('two', true)])).toEqual(['one:false', 'two:true']);
    await expect(auth.token('unknown')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(mock.getAccountByHomeId.mock.calls.map(call => call[0])).toEqual(['one', 'two']);
    store.close();
  });
  it('configures PKCE, nonce and least-privilege scopes then binds the returned identity', async () => {
    const { store, auth } = fixture();
    const { session } = store.newSession();
    await auth.login(session);
    const request = mock.getAuthCodeUrl.mock.calls[0][0];
    expect(request).toMatchObject({ codeChallenge: 'test-challenge', codeChallengeMethod: 'S256' });
    expect(request.scopes).toContain('Files.ReadWrite'); expect(request.scopes).not.toContain('Files.ReadWrite.All');
    mock.acquireTokenByCode.mockResolvedValue({ account: { homeAccountId: 'owner', username: 'test@example.com', name: '用户' }, idTokenClaims: { nonce: request.nonce } });
    const account = await auth.callback('code', request.state, session);
    expect(account.id).toBe('owner'); expect(store.getAccount('owner')).toEqual(account);
    expect(mock.acquireTokenByCode).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: 'test-verifier' }));
    await expect(auth.callback('code', request.state, session)).rejects.toMatchObject({ code: 'INVALID_STATE' }); store.close();
  });
  it('rejects a nonce mismatch but accepts additional accounts with valid state', async () => {
    const { store, auth } = fixture(); const { session } = store.newSession();
    await auth.login(session); let request = mock.getAuthCodeUrl.mock.calls.at(-1)![0];
    mock.acquireTokenByCode.mockResolvedValue({ account: { homeAccountId: 'owner', username: 'test@example.com' }, idTokenClaims: { nonce: 'wrong' } });
    await expect(auth.callback('code', request.state, session)).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    expect(mock.removeAccount).toHaveBeenCalledWith(expect.objectContaining({ homeAccountId: 'owner' }));
    expect(store.getAccount('owner')).toBeNull();
    store.saveAccount({ id: 'existing', name: '原用户', username: 'existing@example.com' });
    await auth.login(session); request = mock.getAuthCodeUrl.mock.calls.at(-1)![0];
    mock.acquireTokenByCode.mockResolvedValue({ account: { homeAccountId: 'other', username: 'other@example.com' }, idTokenClaims: { nonce: request.nonce } });
    expect((await auth.callback('code', request.state, session)).id).toBe('other');
    expect(store.getAccount('existing')?.id).toBe('existing'); expect(store.getAccount('other')?.id).toBe('other');
    expect(request.prompt).toBe('select_account'); expect(request.loginHint).toBeUndefined(); store.close();
  });
  it('refreshes through MSAL and reports when interactive authorization is required', async () => {
    const { store, auth } = fixture(); store.saveAccount({ id: 'owner', name: 'User', username: 'test@example.com' });
    mock.getAccountByHomeId.mockResolvedValue({ homeAccountId: 'owner' });
    mock.acquireTokenSilent.mockResolvedValue({ accessToken: 'fresh-token' });
    expect(await auth.token('owner', true)).toBe('fresh-token');
    expect(mock.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    mock.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError('interaction_required'));
    await expect(auth.token('owner')).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' }); store.close();
  });
  it('persists cache through the MSAL plugin and clears local state on logout', async () => {
    const { store, auth } = fixture();
    const plugin = mock.config.cache.cachePlugin;
    await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => 'encrypted-cache-content' } });
    const deserialize = vi.fn(); await plugin.beforeCacheAccess({ tokenCache: { deserialize } });
    expect(deserialize).toHaveBeenCalledWith('encrypted-cache-content');
    mock.getAllAccounts.mockResolvedValue([{ homeAccountId: 'owner' }]);
    store.saveAccount({ id: 'owner', name: 'User', username: 'test@example.com' }); const { token } = store.newSession('owner');
    mock.getAccountByHomeId.mockResolvedValue({ homeAccountId: 'owner' });
    store.saveAccount({ id: 'other', name: 'Other', username: 'other@example.com' });
    const other = store.newSession('other');
    await auth.clear('owner');
    expect(mock.getAccountByHomeId).toHaveBeenCalledWith('owner');
    expect(mock.removeAccount).toHaveBeenCalledWith({ homeAccountId: 'owner' });
    expect(mock.removeAccount).toHaveBeenCalledTimes(1);
    expect(store.getAccount('owner')).toBeNull(); expect(store.getSession(token)?.accountId).toBeNull();
    expect(store.getAccount('other')?.id).toBe('other'); expect(store.getSession(other.token)?.accountId).toBe('other'); store.close();
  });
  it('shows missing configuration without starting an authorization request', async () => {
    const { store, auth } = fixture(false); expect(auth.missing).toEqual(['MS_CLIENT_ID', 'MS_CLIENT_SECRET']);
    await expect(auth.login(store.newSession().session)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); store.close();
  });
});
