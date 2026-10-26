import type { DriveItem } from '../shared/types.js';
import type { Fetcher } from '../server/graph.js';
import type { ThumbnailSize } from '../shared/images.js';

export class FakeDrive {
  nodes = new Map<string, DriveItem>();
  content = new Map<string, Buffer>();
  thumbnails = new Map<string, Record<ThumbnailSize, Buffer>>();
  denied = new Set<string>();
  requests: { url: string; init?: RequestInit }[] = [];
  sessions = new Map<string, { parentId: string; name: string; itemId?: string; offset: number; bytes: Buffer[]; conflict: string }>();
  dropNextChunkResponse = false;
  nextId = 10;
  constructor() {
    this.nodes.set('root', { id: 'root', name: 'root', size: 0, folder: { childCount: 3 }, eTag: 'root-v1' });
    this.nodes.set('docs', { id: 'docs', name: '文档', size: 0, folder: { childCount: 1 }, eTag: 'docs-v1', parentReference: { id: 'root' } });
    this.nodes.set('sub', { id: 'sub', name: '项目资料', size: 0, folder: { childCount: 0 }, eTag: 'sub-v1', parentReference: { id: 'docs' } });
    this.nodes.set('photos', { id: 'photos', name: '图片', size: 0, folder: { childCount: 0 }, eTag: 'photos-v1', parentReference: { id: 'root' } });
    this.saveFile('root', '说明.txt', Buffer.from('你好，OneDrive'), 'note');
  }
  json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
  saveImage(parentId: string, name: string, id: string, options: { noThumbnail?: boolean; undecodable?: boolean } = {}) {
    const picture = (width: number, label: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width * 0.625}" viewBox="0 0 800 500"><rect width="800" height="500" fill="#d7e8ef"/><circle cx="615" cy="130" r="60" fill="#f7ca79"/><path d="M0 440L260 130L450 340L580 240L800 500H0" fill="#709c93"/><path d="M0 500L315 280L500 500" fill="#436e72"/><text x="40" y="75" fill="#254e65" font-family="sans-serif" font-size="34">${label}</text></svg>`);
    const item = this.saveFile(parentId, name, options.undecodable ? Buffer.from('not a decodable HEIC') : picture(1600, 'ORIGINAL 1600'), id);
    item.file = { mimeType: options.undecodable ? 'image/heic' : 'image/svg+xml' };
    if (!options.noThumbnail) this.thumbnails.set(id, { medium: picture(176, 'MEDIUM 176'), large: picture(800, 'LARGE 800') });
    return item;
  }
  error(status: number, code: string) { return this.json({ error: { code } }, status); }
  saveFile(parentId: string, name: string, bytes: Buffer, id?: string) {
    const itemId = id || `item-${this.nextId++}`;
    const previous = this.nodes.get(itemId);
    const item: DriveItem = { id: itemId, name, size: bytes.length, file: { mimeType: 'application/octet-stream' }, parentReference: { id: parentId, driveId: 'drive' }, eTag: `${itemId}-v${this.nextId++}`, lastModifiedDateTime: new Date().toISOString(), webUrl: `https://onedrive.live.com/?id=${itemId}` };
    if (previous) item.parentReference = previous.parentReference;
    Object.assign(item, { '@microsoft.graph.downloadUrl': `https://test.up.1drv.com/download/${itemId}?secret=test-only` });
    this.nodes.set(itemId, item); this.content.set(itemId, bytes);
    return item;
  }
  private existing(parentId: string, name: string) { return [...this.nodes.values()].find(i => i.parentReference?.id === parentId && i.name === name); }
  private finalName(parentId: string, name: string, conflict: string) {
    if (conflict !== 'rename' || !this.existing(parentId, name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (this.existing(parentId, `${stem} (${n})${ext}`)) n++;
    return `${stem} (${n})${ext}`;
  }
  fetch: Fetcher = async (input, init) => {
    const url = String(input); this.requests.push({ url, init });
    const parsed = new URL(url); const method = init?.method || 'GET';
    if (parsed.hostname === 'test-mediap.svc.ms') {
      const [, , itemId, size] = parsed.pathname.split('/');
      const bytes = this.thumbnails.get(itemId)?.[size as ThumbnailSize];
      return bytes ? new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': String(bytes.length) } }) : this.error(404, 'notFound');
    }
    if (parsed.hostname === 'test.up.1drv.com') {
      if (parsed.pathname.startsWith('/download/')) {
        const bytes = this.content.get(parsed.pathname.slice('/download/'.length));
        return bytes ? new Response(new Uint8Array(bytes), { headers: { 'Content-Length': String(bytes.length) } }) : this.error(404, 'notFound');
      }
      const key = parsed.pathname.split('/').pop()!;
      const session = this.sessions.get(key);
      if (!session) return this.error(404, 'uploadSessionNotFound');
      if (method === 'DELETE') { this.sessions.delete(key); return new Response(null, { status: 204 }); }
      if (method === 'GET') return this.json({ nextExpectedRanges: [`${session.offset}-`], expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(new Headers(init?.headers).get('Content-Range') || '');
      if (!match || Number(match[1]) !== session.offset) return this.error(416, 'invalidRange');
      const bytes = Buffer.from(init?.body as Uint8Array);
      session.bytes.push(bytes); session.offset += bytes.length;
      if (this.dropNextChunkResponse) { this.dropNextChunkResponse = false; throw new TypeError('network interrupted after accepting bytes'); }
      if (session.offset === Number(match[3])) {
        this.sessions.delete(key);
        const name = this.finalName(session.parentId, session.name, session.conflict);
        return this.json(this.saveFile(session.parentId, name, Buffer.concat(session.bytes), session.itemId), 201);
      }
      return this.json({ nextExpectedRanges: [`${session.offset}-`], expirationDateTime: new Date(Date.now() + 3600_000).toISOString() }, 202);
    }
    const path = decodeURIComponent(parsed.pathname.replace('/v1.0', ''));
    if (path === '/me/drive') return this.json({ id: 'drive', name: 'OneDrive', driveType: 'personal', quota: { total: 1024 ** 4, used: 1024 ** 3, remaining: 1024 ** 4 - 1024 ** 3 } });
    if (path === '/me/drive/root') return this.json(this.nodes.get('root'));
    const thumbnailMatch = /^\/me\/drive\/items\/([^/]+)\/thumbnails$/.exec(path);
    if (thumbnailMatch) {
      const itemId = thumbnailMatch[1];
      if (!this.nodes.has(itemId)) return this.error(404, 'notFound');
      const size = parsed.searchParams.get('select') as ThumbnailSize;
      return this.json({ value: this.thumbnails.has(itemId) ? [{ id: '0', [size]: { url: `https://test-mediap.svc.ms/thumbnail/${itemId}/${size}` } }] : [] });
    }
    const sessionMatch = /^\/me\/drive\/items\/([^/:]+)(?::\/(.+):)?\/createUploadSession$/.exec(path);
    if (sessionMatch && method === 'POST') {
      const item = this.nodes.get(sessionMatch[1]);
      if (!item) return this.error(404, 'notFound');
      const tag = new Headers(init?.headers).get('if-match');
      if (tag && tag !== item.eTag) return this.error(412, 'preconditionFailed');
      const body = JSON.parse(init?.body as string);
      const key = `s-${this.nextId++}`;
      this.sessions.set(key, { parentId: sessionMatch[2] ? item.id : item.parentReference!.id!, name: sessionMatch[2] || item.name, itemId: sessionMatch[2] ? undefined : item.id, offset: 0, bytes: [], conflict: body.item['@microsoft.graph.conflictBehavior'] });
      return this.json({ uploadUrl: `https://test.up.1drv.com/session/${key}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
    }
    const contentMatch = /^\/me\/drive\/items\/([^/:]+)(?::\/(.+):)?\/content$/.exec(path);
    if (contentMatch) {
      const item = this.nodes.get(contentMatch[1]);
      if (!item) return this.error(404, 'notFound');
      if (method === 'GET') return new Response(null, { status: 302, headers: { location: `https://test.up.1drv.com/download/${item.id}` } });
      const tag = new Headers(init?.headers).get('if-match');
      if (tag && tag !== item.eTag) return this.error(412, 'preconditionFailed');
      const conflict = parsed.searchParams.get('@microsoft.graph.conflictBehavior') || 'replace';
      const parentId = contentMatch[2] ? item.id : item.parentReference!.id!;
      const name = this.finalName(parentId, contentMatch[2] || item.name, conflict);
      const existing = this.existing(parentId, name);
      if (existing && conflict === 'fail') return this.error(409, 'nameAlreadyExists');
      return this.json(this.saveFile(parentId, name, Buffer.from(init?.body as Uint8Array), contentMatch[2] ? existing?.id : item.id), 201);
    }
    const nameMatch = /^\/me\/drive\/items\/([^/:]+):\/(.+)$/.exec(path);
    if (nameMatch) { const item = this.existing(nameMatch[1], nameMatch[2]); return item ? this.json(item) : this.error(404, 'notFound'); }
    const match = /^\/me\/drive\/items\/([^/]+)(\/children)?$/.exec(path);
    if (!match) return this.error(404, 'notFound');
    const item = this.nodes.get(match[1]);
    if (!item) return this.error(404, 'notFound');
    if (this.denied.has(item.id) && method !== 'GET') return this.error(403, 'accessDenied');
    const tag = new Headers(init?.headers).get('if-match');
    if (tag && tag !== item.eTag) return this.error(412, 'preconditionFailed');
    if (match[2]) {
      if (method === 'GET') return this.json({ value: [...this.nodes.values()].filter(i => i.parentReference?.id === item.id) });
      const body = JSON.parse(init?.body as string);
      if (this.existing(item.id, body.name)) return this.error(409, 'nameAlreadyExists');
      const child: DriveItem = { id: `folder-${this.nextId++}`, name: body.name, folder: { childCount: 0 }, size: 0, eTag: `v${this.nextId++}`, parentReference: { id: item.id }, lastModifiedDateTime: new Date().toISOString() };
      this.nodes.set(child.id, child); return this.json(child, 201);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init?.body as string);
      const parentId = body.parentReference?.id || item.parentReference?.id;
      const existing = this.existing(parentId, body.name || item.name);
      if (existing && existing.id !== item.id) return this.error(409, 'nameAlreadyExists');
      const updated = { ...item, ...body, eTag: `v${this.nextId++}` };
      this.nodes.set(item.id, updated); return this.json(updated);
    }
    if (method === 'DELETE') { this.nodes.delete(item.id); return new Response(null, { status: 204 }); }
    return this.json(item);
  };
}
