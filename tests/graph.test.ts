import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Graph, validateStorageUrl, validateImageUrl } from '../server/graph.js';
import type { AuthProvider } from '../server/auth.js';

function auth() { return { token: vi.fn(async () => 'test-token') } as unknown as AuthProvider; }
describe('Graph transport', () => {
  it('refreshes a rejected token once, without leaking it to storage uploads', async () => {
    const identity = auth();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{"id":"drive"}'));
    const graph = new Graph(identity, randomBytes(32), fetcher);
    expect(await graph.drive()).toEqual({ id: 'drive' });
    expect(identity.token).toHaveBeenCalledWith(true);
    fetcher.mockResolvedValueOnce(new Response('{}'));
    await graph.storage('https://test.up.1drv.com/session/x', { method: 'PUT', body: 'bytes' });
    const options = fetcher.mock.calls[2][1]!;
    expect(new Headers(options.headers).has('Authorization')).toBe(false);
    expect(options.redirect).toBe('error');
  });
  it('honors Retry-After for reads and does not blindly retry writes', async () => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(new Response('{"id":"drive"}'));
    const graph = new Graph(auth(), randomBytes(32), fetcher, wait);
    await graph.drive(); expect(wait).toHaveBeenCalledWith(2000);
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(graph.request('/me/drive/items/x', { method: 'DELETE' })).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('signs pagination cursors and binds them to account and directory', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/items/root/children?$skiptoken=abc' }))).mockResolvedValueOnce(new Response('{"value":[]}'));
    const graph = new Graph(auth(), randomBytes(32), fetcher);
    const page = await graph.children('root', 'owner');
    expect(page.nextCursor).toBeTruthy();
    await expect(graph.children('root', 'another-owner', page.nextCursor)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(graph.children('other-folder', 'owner', page.nextCursor)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(graph.children('root', 'owner', `${page.nextCursor}x`)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await graph.children('root', 'owner', page.nextCursor); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses arbitrary storage destinations', () => {
    for (const url of ['http://test.up.1drv.com/session', 'https://127.0.0.1/session', 'https://sharepoint.com.attacker.example/session', 'https://user:password@a.sharepoint.com/file']) expect(() => validateStorageUrl(url)).toThrow();
    expect(validateStorageUrl('https://tenant-my.sharepoint.com/upload')).toContain('sharepoint.com');
  });
  it('validates every image redirect without forwarding authorization', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://test.up.1drv.com/image' } })).mockResolvedValueOnce(new Response('image'));
    const graph = new Graph(auth(), randomBytes(32), fetcher);
    const signal = new AbortController().signal;
    expect(await (await graph.imageStorage('https://westeurope1-mediap.svc.ms/image', true, signal)).text()).toBe('image');
    for (const [, options] of fetcher.mock.calls) { expect(new Headers(options?.headers).has('Authorization')).toBe(false); expect(options?.redirect).toBe('manual'); }
    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(graph.imageStorage('https://test.up.1drv.com/image', true, signal)).rejects.toMatchObject({ code: 'INVALID_IMAGE_URL' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const url of ['not a URL', 'https://mediap.svc.ms.attacker.example/image', 'https://test.up.1drv.com:8080/file', 'https://user:pass@mediap.svc.ms/file']) expect(() => validateImageUrl(url, true)).toThrow();
    expect(() => validateImageUrl('https://westeurope1-mediap.svc.ms/image', false)).toThrow();
    expect(() => validateStorageUrl('https://westeurope1-mediap.svc.ms/image')).toThrow();
  });
  it('bounds redirect loops and respects cancelled image requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    const graph = new Graph(auth(), randomBytes(32), fetcher);
    const controller = new AbortController();
    await expect(graph.imageStorage('https://test.up.1drv.com/loop', true, controller.signal)).rejects.toMatchObject({ code: 'IMAGE_REDIRECT_LIMIT' });
    expect(fetcher).toHaveBeenCalledTimes(6);
    controller.abort();
    await expect(graph.imageStorage('https://test.up.1drv.com/image', true, controller.signal)).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
