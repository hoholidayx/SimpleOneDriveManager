import { describe, it, expect, vi } from 'vitest';
import { createImageQueue } from '../src/imageRequests';
import { imageMime } from '../shared/images';

describe('image request boundaries', () => {
  it('limits active loads and skips cancelled queued work', async () => {
    const queue = createImageQueue(2);
    const controller = new AbortController();
    const releases: (() => void)[] = [];
    const work = vi.fn(() => new Promise<void>(resolve => releases.push(resolve)));
    const first = queue(work, new AbortController().signal);
    const second = queue(work, new AbortController().signal);
    const cancelled = queue(work, controller.signal).catch(error => error);
    const fourth = queue(work, new AbortController().signal);
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2));
    controller.abort();
    releases[0](); await first;
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(3));
    releases[1](); releases[2]();
    await Promise.all([second, fourth, cancelled]);
    expect(work).toHaveBeenCalledTimes(3);
  });
  it('releases capacity after failure', async () => {
    const queue = createImageQueue(1);
    const signal = new AbortController().signal;
    const failed = queue(async () => { throw new Error('offline'); }, signal).catch(error => error.message);
    const next = queue(async () => 'next', signal);
    expect(await failed).toBe('offline');
    expect(await next).toBe('next');
  });
  it('prefers MIME and only falls back to extension for missing or generic MIME', () => {
    expect(imageMime({ name: 'file.bin', file: { mimeType: 'image/jpeg' } })).toBe('image/jpeg');
    expect(imageMime({ name: 'file.PNG', file: {} })).toBe('image/png');
    expect(imageMime({ name: 'file.heic', file: { mimeType: 'application/octet-stream' } })).toBe('image/heic');
    expect(imageMime({ name: 'file.jpg', file: { mimeType: 'text/html' } })).toBeUndefined();
    expect(imageMime({ name: 'folder.png', folder: { childCount: 0 } })).toBeUndefined();
  });
});
