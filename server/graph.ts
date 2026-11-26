import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthProvider } from './auth.js';
import type { Drive, DriveItem, FolderPage } from '../shared/types.js';
import { AppError, assert } from './errors.js';
import type { ThumbnailSize } from '../shared/images.js';

const BASE = 'https://graph.microsoft.com/v1.0';
export const itemPath = (id: string) => `/me/drive/items/${encodeURIComponent(id)}`;
export function safeItem(item: DriveItem): DriveItem {
  const { id, name, size, eTag, lastModifiedDateTime, webUrl, folder, file, parentReference } = item;
  return { id, name, size, eTag, lastModifiedDateTime, webUrl, folder, file, parentReference };
}
export type Fetcher = typeof fetch;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function validateStorageUrl(value: string) {
  const url = new URL(value);
  const domains = ['1drv.com', 'onedrive.com', 'sharepoint.com', 'storage.live.com'];
  assert(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`)), 'INVALID_STORAGE_URL', 'OneDrive 返回了无法识别的存储地址', 502);
  return url.toString();
}

// Thumbnail hosts are deliberately separate from upload destinations.
export function validateImageUrl(value: string, thumbnail: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(502, 'INVALID_IMAGE_URL', 'OneDrive 返回了无法识别的图片地址'); }
  const domains = ['1drv.com', 'onedrive.com', 'sharepoint.com', 'storage.live.com'];
  const storage = domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`));
  const media = thumbnail && /^(?:[a-z0-9-]+-)?mediap\.svc\.ms$/.test(url.hostname);
  assert(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (storage || media), 'INVALID_IMAGE_URL', 'OneDrive 返回了无法识别的图片地址', 502);
  return url.toString();
}

export class Graph {
  constructor(private auth: AuthProvider, private key: Buffer, public fetcher: Fetcher = fetch, private wait = delay, private accountId = '') {}
  forAccount(accountId: string) {
    return new Graph(this.auth, this.key, (input, init) => this.fetcher(input, init), this.wait, accountId);
  }
  async response(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    assert(path.startsWith('/') && !path.startsWith('//'), 'INVALID_GRAPH_PATH', '接口路径不正确');
    assert(this.accountId, 'LOGIN_REQUIRED', '请求必须指定已授权账号', 401);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.auth.token(this.accountId)}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const safeToRetry = retry && (!init.method || ['GET', 'HEAD'].includes(init.method));
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      let res;
      try { res = await this.fetcher(`${BASE}${path}`, { ...init, headers, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) }); }
      catch { throw new AppError(502, 'GRAPH_NETWORK', '暂时无法连接 OneDrive，请检查网络后重试'); }
      if (res.status === 401 && !refreshed) {
        await res.body?.cancel();
        headers.set('Authorization', `Bearer ${await this.auth.token(this.accountId, true)}`);
        refreshed = true;
        continue;
      }
      if (safeToRetry && (res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = res.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const waitMs = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 1000 * 2 ** attempt;
        await res.body?.cancel();
        if (waitMs > 60_000) throw new AppError(429, 'THROTTLED', 'OneDrive 请求较频繁，请稍后重试');
        await this.wait(Math.max(500, waitMs || 1000));
        continue;
      }
      if (!res.ok && res.status !== 302) await this.raise(res);
      return res;
    }
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.response(path, init);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  async raise(res: Response): Promise<never> {
    const body = await res.json().catch(() => ({})) as { error?: { code?: string } };
    const code = body.error?.code || `HTTP_${res.status}`;
    const messages: Record<number, string> = {
      400: 'OneDrive 拒绝了该操作，请检查名称和目标目录', 401: '授权已失效，请重新连接 OneDrive',
      403: '当前账号没有执行此操作的权限', 404: '文件或目录已不存在，请刷新后重试',
      409: '目标目录已有同名项目，请选择覆盖、保留两份或更换名称',
      412: '文件已被其他操作修改，请刷新后重试', 416: '上传位置已变化，请恢复上传后重试',
      423: '文件正在被使用，请稍后重试', 429: 'OneDrive 请求较频繁，请稍后重试',
      507: 'OneDrive 可用空间不足'
    };
    throw new AppError(res.status >= 500 && res.status !== 507 ? 502 : res.status, code, messages[res.status] || 'OneDrive 操作失败，请稍后重试');
  }
  drive() { return this.request<Drive>('/me/drive?$select=id,name,driveType,quota'); }
  item(id: string, signal?: AbortSignal) { return this.request<DriveItem>(`${itemPath(id)}?$select=id,name,size,eTag,lastModifiedDateTime,folder,file,parentReference,webUrl`, { signal }).then(safeItem); }
  async thumbnail(id: string, size: ThumbnailSize, signal: AbortSignal) {
    const result = await this.request<{ value: Partial<Record<ThumbnailSize, { url: string }>>[] }>(`${itemPath(id)}/thumbnails?select=${size}`, { signal });
    const url = result.value?.find(set => set[size]?.url)?.[size]?.url;
    assert(url, 'NO_THUMBNAIL', '此图片暂时没有可用的缩略图', 404);
    return this.imageStorage(url, true, signal);
  }
  async original(id: string, signal: AbortSignal) {
    const res = await this.response(`${itemPath(id)}/content`, { signal });
    if (res.status !== 302) return res;
    const url = res.headers.get('location');
    await res.body?.cancel();
    assert(url, 'NO_DOWNLOAD_URL', '暂时无法获取原图地址', 502);
    return this.imageStorage(url, false, signal);
  }
  async imageStorage(url: string, thumbnail: boolean, signal: AbortSignal): Promise<Response> {
    for (let hop = 0; hop < 6; hop++) {
      const target = validateImageUrl(url, thumbnail);
      signal.throwIfAborted();
      let res: Response;
      try {
        // Never forward the Graph Authorization header to storage or media hosts.
        res = await this.fetcher(target, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      } catch { throw new AppError(502, 'IMAGE_NETWORK', '图片加载中断，请重试'); }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        assert(location, 'NO_IMAGE_URL', '暂时无法获取图片地址', 502);
        try { url = new URL(location, target).toString(); }
        catch { throw new AppError(502, 'INVALID_IMAGE_URL', 'OneDrive 返回了无法识别的图片地址'); }
        continue;
      }
      if (!res.ok) await this.raise(res);
      return res;
    }
    throw new AppError(502, 'IMAGE_REDIRECT_LIMIT', '图片地址重定向过多，请重试');
  }
  root() { return this.request<DriveItem>('/me/drive/root?$select=id,name,size,eTag,folder,parentReference').then(safeItem); }
  async children(parentId: string, owner: string, cursor?: string): Promise<FolderPage> {
    let path = `${itemPath(parentId)}/children?$top=100&$select=id,name,size,eTag,lastModifiedDateTime,folder,file,parentReference,webUrl`;
    if (cursor) path = this.decodeCursor(cursor, owner, parentId);
    const page = await this.request<{ value: DriveItem[]; '@odata.nextLink'?: string }>(path);
    return { items: page.value.map(safeItem), nextCursor: page['@odata.nextLink'] ? this.encodeCursor(page['@odata.nextLink'], owner, parentId) : undefined };
  }
  private encodeCursor(url: string, owner: string, parentId: string) {
    assert(url.startsWith(`${BASE}/`), 'INVALID_NEXT_LINK', 'OneDrive 分页地址不正确', 502);
    const body = Buffer.from(JSON.stringify({ path: url.slice(BASE.length), owner, parentId, expires: Date.now() + 3600_000 })).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }
  private decodeCursor(cursor: string, owner: string, parentId: string): string {
    try {
      const [body, signature, extra] = cursor.split('.');
      const expected = createHmac('sha256', this.key).update(body).digest();
      const actual = Buffer.from(signature || '', 'base64url');
      assert(!extra && expected.length === actual.length && timingSafeEqual(expected, actual), 'INVALID_CURSOR', '分页已失效，请刷新目录');
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      assert(data.owner === owner && data.parentId === parentId && data.expires > Date.now() && typeof data.path === 'string' && data.path.startsWith('/'), 'INVALID_CURSOR', '分页已失效，请刷新目录');
      return data.path;
    } catch { throw new AppError(400, 'INVALID_CURSOR', '分页已失效，请刷新目录'); }
  }
  async storage(url: string, init: RequestInit = {}): Promise<Response> {
    let res;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000).unref();
    try { res = await this.fetcher(validateStorageUrl(url), { ...init, redirect: 'error', signal: controller.signal }); }
    catch (e) { if (e instanceof AppError) throw e; throw new AppError(502, 'UPLOAD_NETWORK', '传输中断，请稍后恢复任务'); }
    finally { clearTimeout(timeout); }
    if (!res.ok) await this.raise(res);
    return res;
  }
}
