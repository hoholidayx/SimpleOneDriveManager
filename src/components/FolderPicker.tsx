import { useEffect, useState } from 'react';
import { App, Modal, Spin, Tree } from 'antd';
import { FolderFilled } from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import type { DriveItem, FolderPage } from '../../shared/types';
import { api, friendlyError, pathId } from '../api';

export async function folderNodes(id: string, excluded: string[] = []) {
  const folders: DriveItem[] = [];
  let cursor: string | undefined;
  do {
    const page: FolderPage = await api(`/items/${pathId(id)}/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    folders.push(...page.items.filter(i => i.folder && !excluded.includes(i.id)));
    cursor = page.nextCursor;
  } while (cursor);
  return folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(i => ({ key: i.id, title: i.name, icon: <FolderFilled style={{ color: '#f0b445' }} />, isLeaf: i.folder?.childCount === 0 }));
}
export function replaceChildren(nodes: DataNode[], key: React.Key, children: DataNode[]): DataNode[] { return nodes.map(node => node.key === key ? { ...node, children } : node.children ? { ...node, children: replaceChildren(node.children, key, children) } : node); }

export function FolderPicker({ root, excluded, onCancel, onSelect }: { root: DriveItem; excluded: string[]; onCancel: () => void; onSelect: (id: string) => Promise<void> }) {
  const { message } = App.useApp();
  const [nodes, setNodes] = useState<DataNode[]>([{ key: root.id, title: '我的文件', icon: <FolderFilled style={{ color: '#f0b445' }} /> }]);
  const [selected, setSelected] = useState(root.id);
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  useEffect(() => { setLoading(true); void folderNodes(root.id, excluded).then(children => setNodes(old => replaceChildren(old, root.id, children))).catch(e => message.error(friendlyError(e))).finally(() => setLoading(false)); }, [root.id]);
  return <Modal open title="移动到文件夹" okText="移动到这里" cancelText="取消" onCancel={onCancel} confirmLoading={moving} onOk={async () => { setMoving(true); try { await onSelect(selected); } finally { setMoving(false); } }}>
    <p className="muted">选择目标目录，已选文件夹及其子目录不会作为移动目标。</p>
    <div className="folder-picker"><Spin spinning={loading}><Tree blockNode showIcon defaultExpandedKeys={[root.id]} selectedKeys={[selected]} treeData={nodes} onSelect={keys => keys[0] && setSelected(String(keys[0]))} loadData={async node => { if (node.children) return; try { const children = await folderNodes(String(node.key), excluded); setNodes(old => replaceChildren(old, node.key, children)); } catch (e) { message.error(friendlyError(e)); throw e; } }} /></Spin></div>
  </Modal>;
}
