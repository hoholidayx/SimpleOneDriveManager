import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { parseConfig } from '../server/config.js';
import { allowedHostnames, healthHost, listenUrls, loginIssue, requestHostname } from '../server/network.js';

const env = { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), PORT: '3100' };
const interfaces = {
  lan: [{ address: '192.0.2.20', family: 'IPv4', internal: false } as NetworkInterfaceInfo],
  loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as NetworkInterfaceInfo],
  v6: [{ address: '2001:db8::20', family: 'IPv6', internal: false } as NetworkInterfaceInfo]
};
describe('LAN configuration and trusted addresses', () => {
  it('defaults to all IPv4 interfaces and retains localhost OAuth defaults', () => {
    expect(parseConfig(env)).toMatchObject({ host: '0.0.0.0', origin: 'http://localhost:3100', redirectUri: 'http://localhost:3100/api/auth/callback' });
    expect(parseConfig({ ...env, HOST: 'localhost' }).host).toBe('127.0.0.1');
    expect(parseConfig({ ...env, HOST: '::1' }).host).toBe('::1');
  });
  it('allows LAN page addresses and HTTPS callbacks behind a reverse proxy', () => {
    expect(parseConfig({ ...env, APP_ORIGIN: 'http://192.0.2.20:3100', MS_REDIRECT_URI: 'https://drive.example.test/api/auth/callback' }).origin).toBe('http://192.0.2.20:3100');
    expect(parseConfig({ ...env, APP_ORIGIN: 'https://drive.example.test' }).redirectUri).toBe('https://drive.example.test/api/auth/callback');
  });
  it('rejects non-visitable origins and unsupported OAuth callback configurations', () => {
    for (const origin of ['http://0.0.0.0:3100', 'http://[::]:3100', 'https://*.example.test', 'https://user:password@drive.example.test', 'https://drive.example.test/path', 'https://drive.example.test?x=1']) expect(() => parseConfig({ ...env, APP_ORIGIN: origin })).toThrow();
    expect(() => parseConfig({ ...env, MS_REDIRECT_URI: 'http://192.0.2.20:3100/api/auth/callback' })).toThrow('HTTPS');
    expect(() => parseConfig({ ...env, MS_REDIRECT_URI: 'https://drive.example.test/other' })).toThrow('/api/auth/callback');
    expect(() => parseConfig({ ...env, HOST: 'attacker.example' })).toThrow('HOST');
  });
  it('trusts only local interfaces, local machine names and explicitly configured domains', () => {
    const config = parseConfig({ ...env, APP_ORIGIN: 'https://drive.example.test' });
    const hosts = allowedHostnames(config, interfaces, 'server.local');
    for (const host of ['localhost', '127.0.0.1', '[::1]', '192.0.2.20', '[2001:db8::20]', 'server.local', 'drive.example.test']) expect(hosts.has(host)).toBe(true);
    for (const host of ['attacker.example', '192.0.2.99', '0.0.0.0']) expect(hosts.has(host)).toBe(false);
    const localOnly = allowedHostnames({ ...config, host: '127.0.0.1' }, interfaces, 'server.local');
    expect(localOnly.has('192.0.2.20')).toBe(false);
  });
  it('parses Host headers without accepting credentials or path tricks', () => {
    expect(requestHostname('192.0.2.20:3100')).toBe('192.0.2.20');
    expect(requestHostname('[::1]:3100')).toBe('[::1]');
    for (const authority of ['', 'user@localhost', 'localhost/evil', 'localhost\\evil', 'localhost?x=1', 'localhost#x', 'localhost:invalid']) expect(requestHostname(authority)).toBeNull();
  });
  it('uses reachable health addresses and excludes IPv6 URLs for an IPv4 listener', () => {
    expect(listenUrls('0.0.0.0', 3100, interfaces)).toEqual(['http://127.0.0.1:3100', 'http://192.0.2.20:3100']);
    expect(listenUrls('192.0.2.20', 3100, interfaces)).toEqual(['http://192.0.2.20:3100']);
    expect(listenUrls('::1', 3100, interfaces)).toEqual(['http://[::1]:3100']);
    expect(healthHost('::')).toBe('::1');
  });
  it('prevents starting OAuth on an address whose cookies cannot reach the callback', () => {
    const config = parseConfig(env);
    expect(loginIssue(config, '192.0.2.20:3100')).toContain('HTTPS');
    expect(loginIssue(config, 'localhost:5173')).toBeUndefined();
    const lan = parseConfig({ ...env, APP_ORIGIN: 'https://drive.example.test' });
    expect(loginIssue(lan, 'drive.example.test')).toBeUndefined();
  });
});
