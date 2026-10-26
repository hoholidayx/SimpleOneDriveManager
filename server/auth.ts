import { ConfidentialClientApplication, CryptoProvider, InteractionRequiredAuthError, type ICachePlugin } from '@azure/msal-node';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { Store, type Session } from './store.js';
import { AppError, assert } from './errors.js';
import type { Account } from '../shared/types.js';

export const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Files.ReadWrite'];
export interface AuthProvider {
  configured: boolean; missing: string[];
  login(session: Session): Promise<string>;
  callback(code: string, state: string, session: Session): Promise<Account>;
  token(forceRefresh?: boolean): Promise<string>;
  clear(): Promise<void>;
}
export class MicrosoftAuth implements AuthProvider {
  configured: boolean;
  missing: string[];
  private client?: ConfidentialClientApplication;
  constructor(private config: Config, private store: Store) {
    this.missing = [!config.clientId && 'MS_CLIENT_ID', !config.clientSecret && 'MS_CLIENT_SECRET'].filter(Boolean) as string[];
    this.configured = this.missing.length === 0;
    if (this.configured) {
      const cachePlugin: ICachePlugin = {
        beforeCacheAccess: async ctx => { const cache = store.get<string>('msal'); if (cache) ctx.tokenCache.deserialize(cache); },
        afterCacheAccess: async ctx => { if (ctx.cacheHasChanged) store.set('msal', ctx.tokenCache.serialize()); }
      };
      this.client = new ConfidentialClientApplication({ auth: { clientId: config.clientId, clientSecret: config.clientSecret, authority: `https://login.microsoftonline.com/${config.tenantId}` }, cache: { cachePlugin } });
    }
  }
  async login(session: Session) {
    assert(this.client, 'NOT_CONFIGURED', '请先在本机 .env 中填写微软应用信息', 503);
    const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    this.store.saveOAuth(state, session.hash, { verifier, nonce });
    const bound = this.store.getAccount();
    return this.client.getAuthCodeUrl({ scopes: SCOPES, redirectUri: this.config.redirectUri, state, nonce, codeChallenge: challenge, codeChallengeMethod: 'S256', ...(bound ? { loginHint: bound.username } : { prompt: 'select_account' }) });
  }
  async callback(code: string, state: string, session: Session): Promise<Account> {
    assert(this.client, 'NOT_CONFIGURED', '微软应用尚未配置', 503);
    const attempt = this.store.consumeOAuth(state, session.hash);
    assert(attempt, 'INVALID_STATE', '授权已过期或校验失败，请重新连接', 400);
    let result;
    try {
      result = await this.client.acquireTokenByCode({ code, scopes: SCOPES, redirectUri: this.config.redirectUri, codeVerifier: attempt.verifier });
    } catch { throw new AppError(401, 'OAUTH_FAILED', '微软授权失败，请检查应用回调地址、密钥和授权许可后重试'); }
    assert(result?.account, 'INVALID_IDENTITY', '授权身份校验失败，请重新连接', 401);
    if ((result.idTokenClaims as { nonce?: string })?.nonce !== attempt.nonce) {
      await this.client.getTokenCache().removeAccount(result.account);
      throw new AppError(401, 'INVALID_IDENTITY', '授权身份校验失败，请重新连接');
    }
    const account: Account = { id: result.account.homeAccountId, name: result.account.name || result.account.username, username: result.account.username };
    const bound = this.store.getAccount();
    if (bound && bound.id !== account.id) {
      await this.client.getTokenCache().removeAccount(result.account);
      throw new AppError(409, 'ACCOUNT_BOUND', '已连接其他账号，请在原会话退出后再更换账号');
    }
    this.store.set('account', account);
    return account;
  }
  async token(forceRefresh = false): Promise<string> {
    const bound = this.store.getAccount();
    assert(bound && this.client, 'LOGIN_REQUIRED', '请先连接 OneDrive', 401);
    try {
      const account = await this.client.getTokenCache().getAccountByHomeId(bound.id);
      assert(account, 'REAUTH_REQUIRED', '授权已失效，请重新连接', 401);
      const result = await this.client.acquireTokenSilent({ account, scopes: ['User.Read', 'Files.ReadWrite'], forceRefresh });
      return result.accessToken;
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (e instanceof InteractionRequiredAuthError) throw new AppError(401, 'REAUTH_REQUIRED', '授权需要重新确认，请重新连接 OneDrive');
      throw new AppError(503, 'TOKEN_UNAVAILABLE', '暂时无法连接微软登录服务，请稍后重试');
    }
  }
  async clear() {
    if (this.client) {
      const cache = this.client.getTokenCache();
      for (const account of await cache.getAllAccounts()) await cache.removeAccount(account);
    }
    this.store.clearAccount();
  }
}
