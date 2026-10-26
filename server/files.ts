import { Graph, itemPath, safeItem } from './graph.js';
import { assert, AppError, errorMessage } from './errors.js';
import type { BatchResult, DriveItem, ItemDetails } from '../shared/types.js';

export function validateName(value: unknown): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !/["*:<>?\\/|\u0000-\u001f]/.test(value) && !/[. ]$/.test(value), 'INVALID_NAME', '名称不能为空，不能以空格或句点结尾，且不能包含 " * : < > ? / \\ | 等字符');
}
export class Files {
  constructor(public graph: Graph) {}
  async details(id: string): Promise<ItemDetails> {
    const item = await this.graph.item(id);
    const breadcrumbs = [{ id: item.id, name: item.folder ? item.name : '' }];
    let parent = item.parentReference?.id;
    const seen = new Set([item.id]);
    while (parent) {
      assert(!seen.has(parent) && seen.size < 100, 'INVALID_HIERARCHY', '目录层级异常', 502);
      seen.add(parent);
      const folder = await this.graph.item(parent);
      breadcrumbs.unshift({ id: folder.id, name: folder.name });
      parent = folder.parentReference?.id;
    }
    if (!item.folder) breadcrumbs.pop();
    if (breadcrumbs.length) breadcrumbs[0].name = '我的文件';
    return { item, breadcrumbs };
  }
  async writable(id: string) {
    const [item, root] = await Promise.all([this.graph.item(id), this.graph.root()]);
    assert(item.id !== root.id, 'ROOT_PROTECTED', '不能重命名、移动或删除根目录');
    return item;
  }
  async createFolder(parentId: string, name: unknown) {
    validateName(name);
    const parent = await this.graph.item(parentId);
    assert(parent.folder, 'NOT_FOLDER', '目标必须是文件夹');
    return this.graph.request<DriveItem>(`${itemPath(parentId)}/children`, { method: 'POST', body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) }).then(safeItem);
  }
  async update(id: string, body: { name?: unknown; parentId?: unknown; eTag?: unknown }) {
    const item = await this.writable(id);
    const patch: { name?: string; parentReference?: { id: string } } = {};
    if (body.name !== undefined) { validateName(body.name); patch.name = body.name; }
    if (body.parentId !== undefined) {
      assert(typeof body.parentId === 'string' && body.parentId.length > 0, 'INVALID_PARENT', '请选择目标目录');
      let target = await this.graph.item(body.parentId);
      assert(target.folder, 'NOT_FOLDER', '目标必须是文件夹');
      patch.parentReference = { id: target.id };
      if (item.folder) {
        const seen = new Set<string>();
        while (true) {
          assert(target.id !== id, 'INVALID_MOVE', '不能将文件夹移动到自身或后代目录');
          assert(!seen.has(target.id) && seen.size < 100, 'INVALID_HIERARCHY', '目录层级异常');
          seen.add(target.id);
          if (!target.parentReference?.id) break;
          target = await this.graph.item(target.parentReference.id);
        }
      }
    }
    assert(Object.keys(patch).length > 0, 'EMPTY_UPDATE', '没有需要修改的内容');
    const etag = typeof body.eTag === 'string' ? body.eTag : item.eTag;
    return this.graph.request<DriveItem>(itemPath(id), { method: 'PATCH', headers: etag ? { 'if-match': etag } : {}, body: JSON.stringify(patch) }).then(safeItem);
  }
  async remove(id: string, eTag?: string) {
    const item = await this.writable(id);
    const tag = eTag || item.eTag;
    await this.graph.request(itemPath(id), { method: 'DELETE', headers: tag ? { 'if-match': tag } : {} });
  }
  async batch(action: 'move' | 'delete', items: { id: string; eTag?: string }[], parentId?: string): Promise<BatchResult[]> {
    assert(items.length > 0 && items.length <= 500, 'INVALID_BATCH', '每批请选择 1–500 个项目');
    assert(new Set(items.map(i => i.id)).size === items.length, 'DUPLICATE_ITEMS', '批量操作包含重复项目');
    const results: BatchResult[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        try {
          if (action === 'delete') await this.remove(item.id, item.eTag);
          else await this.update(item.id, { parentId, eTag: item.eTag });
          results[index] = { id: item.id, ok: true };
        } catch (e) { results[index] = { id: item.id, ok: false, error: errorMessage(e), code: e instanceof AppError ? e.code : 'FAILED' }; }
      }
    }));
    return results;
  }
}
