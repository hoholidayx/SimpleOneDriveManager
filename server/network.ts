import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isIP } from 'node:net';
import type { Config } from './config.js';

export function listenHost(value = '0.0.0.0') {
  const host = value === 'localhost' ? '127.0.0.1' : value;
  if (!isIP(host)) throw new Error('HOST 必须是监听 IP，例如 0.0.0.0、127.0.0.1 或本机局域网 IP');
  return host;
}
export function hostInUrl(host: string) { return isIP(host) === 6 ? `[${host}]` : host; }
export function healthHost(host: string) { return host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host; }
export function isLoopback(host: string) { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'; }

export function requestHostname(authority: string) {
  try {
    const url = new URL(`http://${authority}`);
    if (!authority || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[\s\\/]/.test(authority)) return null;
    return url.hostname;
  } catch { return null; }
}

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
export function allowedHostnames(config: Pick<Config, 'host' | 'origin' | 'redirectUri'>, interfaces: Interfaces = networkInterfaces(), machine = hostname()) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', new URL(config.origin).hostname, new URL(config.redirectUri).hostname]);
  if (!['0.0.0.0', '::'].includes(config.host)) hosts.add(hostInUrl(config.host));
  else {
    for (const info of Object.values(interfaces).flat()) {
      if (info && !info.address.includes('%')) hosts.add(hostInUrl(info.address));
    }
    if (machine) { hosts.add(machine.toLowerCase()); hosts.add(machine.split('.')[0].toLowerCase()); }
  }
  return hosts;
}

export function listenUrls(host: string, port: number, interfaces: Interfaces = networkInterfaces()) {
  const addresses = new Set([healthHost(host)]);
  if (host === '0.0.0.0' || host === '::') {
    for (const info of Object.values(interfaces).flat()) {
      if (info && !info.internal && !info.address.includes('%') && (host === '::' || info.family === 'IPv4')) addresses.add(info.address);
    }
  }
  return [...addresses].map(address => `http://${hostInUrl(address)}:${port}`);
}

export function loginIssue(config: Pick<Config, 'origin' | 'redirectUri'>, authority: string) {
  const host = requestHostname(authority);
  if (host === new URL(config.origin).hostname && host === new URL(config.redirectUri).hostname) return;
  return '当前访问地址与授权回调的主机名不一致。其他设备登录请配置同一 HTTPS 域名的 APP_ORIGIN 和 MS_REDIRECT_URI；本机调试请使用配置中的页面地址。';
}
