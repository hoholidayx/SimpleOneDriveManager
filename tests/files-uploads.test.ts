import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Files, validateName } from '../server/files.js';
import { Uploads } from '../server/uploads.js';
import { Store } from '../server/store.js';
import { Graph } from '../server/graph.js';
import type { AuthProvider } from '../server/auth.js';
import { CHUNK_SIZE } from '../shared/types.js';
import { FakeDrive } from './fake-drive.js';

let remote: FakeDrive; let graph: Graph; let store: Store; let uploads: Uploads; let files: Files;
beforeEach(() => {
  remote = new FakeDrive(); store = new Store(':memory:', randomBytes(32));
  graph = new Graph({ token: async () => 'token' } as AuthProvider, randomBytes(32), remote.fetch).forAccount('owner');
  files = new Files(graph); uploads = new Uploads(graph, store);
});
afterEach(() => store.close());
describe('files and directories', () => {
  it('creates Chinese folders, renames, moves to root, then deletes', async () => {
    const folder = await files.createFolder('docs', '新的资料 #1');
    expect(folder.parentReference?.id).toBe('docs');
    const renamed = await files.update(folder.id, { name: '已整理', eTag: folder.eTag });
    const moved = await files.update(renamed.id, { parentId: 'root', eTag: renamed.eTag });
    expect(moved.parentReference?.id).toBe('root');
    await files.remove(moved.id, moved.eTag); expect(remote.nodes.has(moved.id)).toBe(false);
  });
  it('protects root, rejects ancestor-to-descendant moves and stale updates', async () => {
    await expect(files.remove('root')).rejects.toMatchObject({ code: 'ROOT_PROTECTED' });
    await expect(files.update('docs', { parentId: 'sub' })).rejects.toMatchObject({ code: 'INVALID_MOVE' });
    await expect(files.update('docs', { parentId: 'docs' })).rejects.toMatchObject({ code: 'INVALID_MOVE' });
    await expect(files.update('note', { name: 'changed.txt', eTag: 'old-etag' })).rejects.toMatchObject({ status: 412 });
    expect(remote.nodes.get('note')?.name).toBe('说明.txt');
  });
  it('returns individual batch outcomes and preserves successes', async () => {
    remote.denied.add('photos');
    const results = await files.batch('delete', [{ id: 'note' }, { id: 'photos' }]);
    expect(results[0]).toEqual({ id: 'note', ok: true });
    expect(results[1]).toMatchObject({ id: 'photos', ok: false, code: 'accessDenied' });
    expect(remote.nodes.has('note')).toBe(false); expect(remote.nodes.has('photos')).toBe(true);
  });
  it('returns breadcrumbs and validates names', async () => {
    expect((await files.details('sub')).breadcrumbs.map(i => i.name)).toEqual(['我的文件', '文档', '项目资料']);
    for (const name of ['', '..', 'a/b', 'trailing.', 'a\\b', 'a?b']) expect(() => validateName(name)).toThrow();
    expect(() => validateName('中文资料 #1')).not.toThrow();
  });
});
describe('upload tasks', () => {
  const input = (name = 'new.txt', size = 4) => ({ name, sourceName: name, size, parentId: 'root', lastModified: 123 });
  it('uploads a small and an empty file without exposing storage credentials', async () => {
    const task = await uploads.create(input(), 'owner');
    const done = await uploads.write(task.id, 'owner', Buffer.from('test'));
    expect(done.state).toBe('completed'); expect(remote.content.get(done.item!.id)?.toString()).toBe('test');
    expect(done).not.toHaveProperty('owner'); expect(done).not.toHaveProperty('uploadUrl');
    expect(done.item).not.toHaveProperty('@microsoft.graph.downloadUrl');
    const zero = await uploads.create(input('empty.txt', 0), 'owner');
    expect((await uploads.write(zero.id, 'owner', Buffer.alloc(0))).state).toBe('completed');
    await expect(uploads.status(task.id, 'someone-else')).rejects.toMatchObject({ status: 404 });
  });
  it('asks on conflicts and supports rename and explicit content replacement', async () => {
    await expect(uploads.create(input('说明.txt'), 'owner')).rejects.toMatchObject({ status: 409 });
    const renamed = await uploads.create({ ...input('说明.txt'), conflict: 'rename' }, 'owner');
    const done = await uploads.write(renamed.id, 'owner', Buffer.from('copy'));
    expect(done.item?.name).toBe('说明 (1).txt');
    expect(remote.content.get('note')?.toString()).toBe('你好，OneDrive');
    const original = remote.nodes.get('note')!;
    const replacement = await uploads.create({ ...input('说明.txt'), sourceName: 'different-name.txt', itemId: 'note', eTag: original.eTag }, 'owner');
    const replaced = await uploads.write(replacement.id, 'owner', Buffer.from('next'));
    expect(replaced.item?.name).toBe('说明.txt'); expect(replaced.sourceName).toBe('different-name.txt');
    expect(remote.content.get('note')?.toString()).toBe('next');
  });
  it('reconciles a lost chunk response and resumes after a manager restart', async () => {
    const task = await uploads.create(input('large.bin', CHUNK_SIZE + 7), 'owner');
    const first = Buffer.alloc(CHUNK_SIZE, 42); const tail = Buffer.from('1234567');
    remote.dropNextChunkResponse = true;
    await expect(uploads.write(task.id, 'owner', first, `bytes 0-${CHUNK_SIZE - 1}/${task.size}`)).rejects.toMatchObject({ code: 'UPLOAD_NETWORK' });
    const restarted = new Uploads(graph, store);
    const reconciled = await restarted.status(task.id, 'owner', true);
    expect(reconciled.offset).toBe(CHUNK_SIZE);
    const done = await restarted.write(task.id, 'owner', tail, `bytes ${CHUNK_SIZE}-${task.size - 1}/${task.size}`);
    expect(done.state).toBe('completed');
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(digest(remote.content.get(done.item!.id)!)).toBe(digest(Buffer.concat([first, tail])));
  });
  it('rejects invalid ranges, handles cancellation and session expiration', async () => {
    const task = await uploads.create(input('large.bin', CHUNK_SIZE + 5), 'owner');
    await expect(uploads.write(task.id, 'owner', Buffer.alloc(4), `bytes 0-3/${task.size}`)).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    expect((await uploads.cancel(task.id, 'owner')).state).toBe('cancelled');
    await expect(uploads.write(task.id, 'owner', Buffer.alloc(4))).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
    const expiring = await uploads.create(input('expired.bin', CHUNK_SIZE + 5), 'owner');
    remote.sessions.clear();
    expect((await uploads.status(expiring.id, 'owner', true)).state).toBe('expired');
  });
  it('applies ETag protection when replacing a file', async () => {
    const task = await uploads.create({ ...input('说明.txt'), itemId: 'note', eTag: 'stale' }, 'owner');
    await expect(uploads.write(task.id, 'owner', Buffer.from('next'))).rejects.toMatchObject({ status: 412 });
    expect(remote.content.get('note')?.toString()).toBe('你好，OneDrive');
  });
  it('locks upload reconciliation against concurrent writes and cancellation', async () => {
    const task = await uploads.create(input('reconcile.bin', CHUNK_SIZE + 5), 'owner');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const fetcher = graph.fetcher;
    graph.fetcher = async (url, init) => {
      if (String(url).includes('/session/') && (!init?.method || init.method === 'GET')) { started(); await gate; }
      return fetcher(url, init);
    };
    const reconciliation = uploads.status(task.id, 'owner', true);
    await entered;
    try {
      await expect(uploads.write(task.id, 'owner', Buffer.alloc(1))).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
      await expect(uploads.cancel(task.id, 'owner')).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
    } finally { release(); }
    expect((await reconciliation).state).toBe('paused');
    expect(store.upload(task.id)?.offset).toBe(0);
  });
});
