import { randomUUID } from 'node:crypto';
import { Store, type StoredUpload } from './store.js';
import { Graph, itemPath, safeItem, validateStorageUrl } from './graph.js';
import { AppError, assert } from './errors.js';
import { validateName } from './files.js';
import { CHUNK_SIZE, type ConflictBehavior, type DriveItem, type UploadTask } from '../shared/types.js';

interface SessionResponse { uploadUrl?: string; expirationDateTime: string; nextExpectedRanges?: string[] }
interface CreateUpload { name: string; sourceName?: string; size: number; lastModified: number; parentId: string; conflict?: ConflictBehavior; itemId?: string; eTag?: string }
export function publicTask(task: StoredUpload): UploadTask {
  const { owner: _owner, uploadUrl: _url, conflict: _conflict, itemId: _itemId, eTag: _etag, ...safe } = task;
  return { ...safe, ...(safe.item ? { item: safeItem(safe.item) } : {}) };
}
export class Uploads {
  private active = new Set<string>();
  constructor(private graph: Graph, private store: Store) {}
  get(id: string, owner: string) {
    const task = this.store.upload(id);
    assert(task && task.owner === owner, 'UPLOAD_NOT_FOUND', '上传任务不存在', 404);
    return task;
  }
  async create(input: CreateUpload, owner: string) {
    validateName(input.name);
    if (input.sourceName !== undefined) validateName(input.sourceName);
    assert(Number.isSafeInteger(input.size) && input.size >= 0, 'INVALID_SIZE', '文件大小不正确');
    assert(Number.isSafeInteger(input.lastModified) && input.lastModified >= 0, 'INVALID_FILE', '文件修改时间不正确');
    assert(['fail', 'replace', 'rename'].includes(input.conflict || 'fail'), 'INVALID_CONFLICT', '同名处理方式不正确');
    const parent = await this.graph.item(input.parentId);
    assert(parent.folder, 'NOT_FOLDER', '上传目标必须是文件夹');
    let existing: DriveItem | undefined;
    if (input.itemId) {
      existing = await this.graph.item(input.itemId);
      assert(existing.file && existing.parentReference?.id === parent.id, 'INVALID_REPLACEMENT', '只能替换当前目录中的文件');
      input.name = existing.name;
      input.conflict = 'replace';
    } else {
      try { existing = await this.graph.request<DriveItem>(`${itemPath(parent.id)}:/${encodeURIComponent(input.name)}`); }
      catch (e) { if (!(e instanceof AppError && e.status === 404)) throw e; }
      if (existing && (input.conflict || 'fail') === 'fail') throw new AppError(409, 'nameAlreadyExists', '已有同名文件，请选择覆盖、保留两份或跳过');
      if (existing && input.conflict === 'replace') assert(existing.file, 'FOLDER_CONFLICT', '同名项目是文件夹，请保留两份或更换名称', 409);
    }
    const task: StoredUpload = {
      id: randomUUID(), owner, name: input.name, sourceName: input.sourceName || input.name, size: input.size, lastModified: input.lastModified,
      parentId: parent.id, offset: 0, state: 'pending', conflict: input.conflict || 'fail',
      createdAt: Date.now(), updatedAt: Date.now(),
      itemId: input.itemId || (existing && input.conflict === 'replace' ? existing.id : undefined),
      eTag: input.eTag || (input.conflict === 'replace' ? existing?.eTag : undefined)
    };
    if (task.size > CHUNK_SIZE) {
      const path = task.itemId ? `${itemPath(task.itemId)}/createUploadSession` : `${itemPath(task.parentId)}:/${encodeURIComponent(task.name)}:/createUploadSession`;
      const session = await this.graph.request<SessionResponse>(path, {
        method: 'POST', headers: task.eTag ? { 'if-match': task.eTag } : {},
        body: JSON.stringify({ item: { name: task.name, '@microsoft.graph.conflictBehavior': task.conflict } })
      });
      assert(session.uploadUrl, 'INVALID_UPLOAD_SESSION', 'OneDrive 未返回上传地址', 502);
      task.uploadUrl = validateStorageUrl(session.uploadUrl);
      task.expiresAt = session.expirationDateTime;
    }
    this.store.saveUpload(task);
    return publicTask(task);
  }
  private async locked<T>(id: string, work: () => Promise<T>) {
    assert(!this.active.has(id), 'UPLOAD_BUSY', '当前分片正在传输，请稍后重试', 409);
    this.active.add(id);
    try { return await work(); } finally { this.active.delete(id); }
  }
  private save(task: StoredUpload) { task.updatedAt = Date.now(); this.store.saveUpload(task); return publicTask(task); }
  async status(id: string, owner: string, reconcile = false) {
    const task = this.get(id, owner);
    const uploadUrl = task.uploadUrl;
    if (reconcile && uploadUrl && !this.active.has(id) && !['completed', 'cancelled', 'expired'].includes(task.state)) {
      return this.locked(id, async () => {
        try {
          const res = await this.graph.storage(uploadUrl);
          const session = await res.json() as SessionResponse;
          task.offset = Number(session.nextExpectedRanges?.[0]?.split('-')[0] || 0);
          task.expiresAt = session.expirationDateTime;
          task.state = 'paused'; task.error = undefined;
        } catch (e) {
          if (e instanceof AppError && [404, 410].includes(e.status)) { task.state = 'expired'; task.error = '上传会话已过期，请刷新文件列表并重新上传'; }
          else throw e;
        }
        return this.save(task);
      });
    }
    if (['pending', 'uploading'].includes(task.state) && !this.active.has(id)) { task.state = 'paused'; return this.save(task); }
    return publicTask(task);
  }
  async write(id: string, owner: string, bytes: Buffer, range?: string) {
    return this.locked(id, async () => {
      const task = this.get(id, owner);
      assert(!['cancelled', 'expired'].includes(task.state), 'UPLOAD_CLOSED', '该上传任务已结束，请重新上传', 409);
      if (task.state === 'completed') return publicTask(task);
      assert(bytes.length <= CHUNK_SIZE, 'CHUNK_TOO_LARGE', '单个分片不能超过 10 MiB', 413);
      task.state = 'uploading'; task.error = undefined;
      if (task.uploadUrl) {
        const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || '');
        assert(parsed, 'INVALID_RANGE', '上传范围不正确');
        const [, a, b, total] = parsed.map(Number);
        assert(a === task.offset && b >= a && b < task.size && Number(total) === task.size && b - a + 1 === bytes.length && (b + 1 === task.size || bytes.length === CHUNK_SIZE), 'INVALID_RANGE', '上传范围与服务端进度不一致，请恢复任务后重试', 409);
      } else assert(task.size <= CHUNK_SIZE && bytes.length === task.size, 'INVALID_SIZE', '上传内容与文件大小不一致');
      this.save(task);
      try {
        let res: Response;
        if (task.uploadUrl) {
          res = await this.graph.storage(task.uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(bytes.length), 'Content-Range': range! }, body: new Uint8Array(bytes) });
        } else {
          const target = task.itemId ? `${itemPath(task.itemId)}/content` : `${itemPath(task.parentId)}:/${encodeURIComponent(task.name)}:/content?@microsoft.graph.conflictBehavior=${task.conflict}`;
          res = await this.graph.response(target, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(task.eTag ? { 'if-match': task.eTag } : {}) }, body: new Uint8Array(bytes) }, false);
        }
        const data = await res.json() as SessionResponse & DriveItem;
        if (res.status === 202) {
          const offset = Number(data.nextExpectedRanges?.[0]?.split('-')[0]);
          assert(Number.isSafeInteger(offset) && offset > task.offset && offset <= task.size, 'INVALID_OFFSET', 'OneDrive 返回了异常的上传进度', 502);
          task.offset = offset; task.expiresAt = data.expirationDateTime;
        } else {
          assert(data.id && data.size === task.size, 'INVALID_UPLOAD_RESULT', '上传结果无法确认，请刷新文件列表', 502);
          task.offset = task.size; task.state = 'completed'; task.item = safeItem(data); task.uploadUrl = undefined;
        }
        return this.save(task);
      } catch (e) {
        task.state = e instanceof AppError && [404, 410].includes(e.status) ? 'expired' : 'failed';
        task.error = e instanceof Error ? e.message : '上传失败，请重试';
        this.save(task);
        throw e;
      }
    });
  }
  async pause(id: string, owner: string) {
    return this.locked(id, async () => {
      const task = this.get(id, owner);
      if (!['completed', 'cancelled', 'expired'].includes(task.state)) task.state = 'paused';
      return this.save(task);
    });
  }
  async cancel(id: string, owner: string) {
    return this.locked(id, async () => {
      const task = this.get(id, owner);
      if (task.state === 'completed') return publicTask(task);
      if (task.uploadUrl) {
        try { await this.graph.storage(task.uploadUrl, { method: 'DELETE' }); }
        catch (e) { if (!(e instanceof AppError && [404, 410].includes(e.status))) throw e; }
      }
      task.state = 'cancelled'; task.uploadUrl = undefined;
      return this.save(task);
    });
  }
  isActive() { return this.active.size > 0; }
}
