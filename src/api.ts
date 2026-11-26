import type { ApiErrorBody, AuthStatus } from '../shared/types';
let csrf = '';
let accountId = '';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
async function apiResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accountId && path !== '/auth/status') headers.set('X-Account-ID', accountId);
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-CSRF-Token', csrf);
  let res: Response;
  try { res = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' }); }
  catch (error) { if (init.signal?.aborted) throw error; throw new ApiError(0, 'NETWORK', '无法连接本地服务，请检查服务状态后重试'); }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as ApiErrorBody | null;
    if (res.status === 401) window.dispatchEvent(new Event('odm-auth-required'));
    if (body?.error.code === 'ACCOUNT_CHANGED') window.dispatchEvent(new Event('odm-account-changed'));
    throw new ApiError(res.status, body?.error.code || 'FAILED', body?.error.message || `请求失败（${res.status}）`);
  }
  return res;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiResponse(path, init);
  return res.status === 204 ? undefined as T : await res.json() as T;
}
export async function imageBlob(path: string, signal: AbortSignal) { return (await apiResponse(path, { signal })).blob(); }
export async function authStatus() {
  const status = await api<AuthStatus>('/auth/status');
  if (accountId && accountId !== status.account?.id) window.dispatchEvent(new Event('odm-account-changed'));
  csrf = status.csrfToken; accountId = status.account?.id || '';
  return status;
}
export const json = (value: unknown) => JSON.stringify(value);
export const pathId = (value: string) => encodeURIComponent(value);
export function formatBytes(size?: number) {
  if (size === undefined) return '—';
  if (size === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export const formatDate = (value?: string | number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const friendlyError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  // HTTP 局域网页面不是 secure context，使用用户点击触发的复制回退。
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed'; textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('无法自动复制，请手动复制');
  } finally { textarea.remove(); }
}
