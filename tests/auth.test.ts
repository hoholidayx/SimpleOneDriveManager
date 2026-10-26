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
  it('configures PKCE, nonce and least-privilege scopes then binds the returned identity', async () => {
    const { store, auth } = fixture();
    const { session } = store.newSession();
    await auth.login(session);
    const request = mock.getAuthCodeUrl.mock.calls[0][0];
    expect(request).toMatchObject({ codeChallenge: 'test-challenge', codeChallengeMethod: 'S256' });
    expect(request.scopes).toContain('Files.ReadWrite'); expect(request.scopes).not.toContain('Files.ReadWrite.All');
    mock.acquireTokenByCode.mockResolvedValue({ account: { homeAccountId: 'owner', username: 'test@example.com', name: '用户' }, idTokenClaims: { nonce: request.nonce } });
    const account = await auth.callback('code', request.state, session);
    expect(account.id).toBe('owner'); expect(store.getAccount()).toEqual(account);
    expect(mock.acquireTokenByCode).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: 'test-verifier' }));
    await expect(auth.callback('code', request.state, session)).rejects.toMatchObject({ code: 'INVALID_STATE' }); store.close();
  });
  it('rejects a nonce mismatch and a different bound account', async () => {
    const { store, auth } = fixture(); const { session } = store.newSession();
    await auth.login(session); let request = mock.getAuthCodeUrl.mock.calls.at(-1)![0];
    mock.acquireTokenByCode.mockResolvedValue({ account: { homeAccountId: 'owner', username: 'test@example.com' }, idTokenClaims: { nonce: 'wrong' } });
    await expect(auth.callback('code', request.state, session)).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    expect(mock.removeAccount).toHaveBeenCalledWith(expect.objectContaining({ homeAccountId: 'owner' }));
    expect(store.getAccount()).toBeNull();
    store.set('account', { id: 'existing', name: '原用户', username: 'existing@example.com' });
    await auth.login(session); request = mock.getAuthCodeUrl.mock.calls.at(-1)![0];
    mock.acquireTokenByCode.mockResolvedValue({ account: { homeAccountId: 'other', username: 'other@example.com' }, idTokenClaims: { nonce: request.nonce } });
    await expect(auth.callback('code', request.state, session)).rejects.toMatchObject({ code: 'ACCOUNT_BOUND' });
    expect(store.getAccount()?.id).toBe('existing'); expect(mock.removeAccount).toHaveBeenCalled(); store.close();
  });
  it('refreshes through MSAL and reports when interactive authorization is required', async () => {
    const { store, auth } = fixture(); store.set('account', { id: 'owner', name: 'User', username: 'test@example.com' });
    mock.getAccountByHomeId.mockResolvedValue({ homeAccountId: 'owner' });
    mock.acquireTokenSilent.mockResolvedValue({ accessToken: 'fresh-token' });
    expect(await auth.token(true)).toBe('fresh-token');
    expect(mock.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    mock.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError('interaction_required'));
    await expect(auth.token()).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' }); store.close();
  });
  it('persists cache through the MSAL plugin and clears local state on logout', async () => {
    const { store, auth } = fixture();
    const plugin = mock.config.cache.cachePlugin;
    await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => 'encrypted-cache-content' } });
    const deserialize = vi.fn(); await plugin.beforeCacheAccess({ tokenCache: { deserialize } });
    expect(deserialize).toHaveBeenCalledWith('encrypted-cache-content');
    mock.getAllAccounts.mockResolvedValue([{ homeAccountId: 'owner' }]);
    store.set('account', { id: 'owner', name: 'User', username: 'test@example.com' }); const { token } = store.newSession('owner');
    await auth.clear(); expect(mock.removeAccount).toHaveBeenCalled(); expect(store.get('msal')).toBeNull(); expect(store.getSession(token)).toBeNull(); store.close();
  });
  it('shows missing configuration without starting an authorization request', async () => {
    const { store, auth } = fixture(false); expect(auth.missing).toEqual(['MS_CLIENT_ID', 'MS_CLIENT_SECRET']);
    await expect(auth.login(store.newSession().session)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); store.close();
  });
});
