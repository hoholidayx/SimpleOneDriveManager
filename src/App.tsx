import { useCallback, useEffect, useRef, useState, type Key } from 'react';
import { Alert, App as AntApp, Avatar, Badge, Breadcrumb as AntBreadcrumb, Button, Descriptions, Divider, Drawer, Dropdown, Empty, Input, Modal, Progress, Space, Spin, Table, Tag, Tooltip, Tree } from 'antd';
import { AppstoreOutlined, UnorderedListOutlined, ArrowDownOutlined, ArrowRightOutlined, CheckCircleFilled, CheckOutlined, CloudOutlined, CloudServerOutlined, CloudUploadOutlined, CopyOutlined, DeleteOutlined, DisconnectOutlined, DownloadOutlined, EllipsisOutlined, FileAddOutlined, FolderAddOutlined, FolderFilled, FolderOpenOutlined, FolderOutlined, InfoCircleOutlined, LinkOutlined, LoadingOutlined, LogoutOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, SafetyCertificateOutlined, SearchOutlined, SettingOutlined, SwapOutlined, UploadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DataNode } from 'antd/es/tree';
import type { Account, AuthStatus, BatchResult, Breadcrumb, ConflictBehavior, Drive, DriveItem, FolderPage, ItemDetails, UploadTask } from '../shared/types';
import { api, authStatus, copyText, formatBytes, formatDate, friendlyError, json, pathId } from './api';
import { FileIcon } from './components/FileIcon';
import { FolderPicker, folderNodes, replaceChildren } from './components/FolderPicker';
import { useUploads } from './useUploads';
import { imageMime } from '../shared/images';
import { FileGrid } from './components/FileGrid';
import { ImagePreview } from './components/ImagePreview';

type Nav = 'files' | 'transfers' | 'settings';
type BatchReport = { action: 'move' | 'delete'; items: DriveItem[]; results: BatchResult[]; parentId?: string };
const stateNames: Record<UploadTask['state'], string> = { pending: '等待上传', uploading: '正在上传', paused: '已暂停', completed: '已完成', failed: '上传失败', cancelled: '已取消', expired: '会话已过期' };

export default function App() {
  const { message, modal } = AntApp.useApp();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [initialError, setInitialError] = useState('');
  const [reauth, setReauth] = useState(false);
  const [nav, setNav] = useState<Nav>('files');
  const [drive, setDrive] = useState<Drive | null>(null);
  const [root, setRoot] = useState<DriveItem | null>(null);
  const [folder, setFolder] = useState<DriveItem | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<Key[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [driveError, setDriveError] = useState('');
  const [tree, setTree] = useState<DataNode[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [editing, setEditing] = useState<{ type: 'folder' | 'rename'; name: string; item?: DriveItem } | null>(null);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState<DriveItem[] | null>(null);
  const [preview, setPreview] = useState<DriveItem | null>(null);
  const [gridSuspended, setGridSuspended] = useState(false);
  const [layout, setLayout] = useState<'list' | 'grid'>(() => {
    try { return localStorage.getItem('odm-file-layout') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  });
  useEffect(() => { try { localStorage.setItem('odm-file-layout', layout); } catch { /* Private storage may be disabled. */ } }, [layout]);
  useEffect(() => { setPreview(null); }, [nav, reauth, status?.connected]);
  const [details, setDetails] = useState<DriveItem | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const resumeInput = useRef<HTMLInputElement>(null);
  const replacement = useRef<DriveItem | null>(null);
  const resumeTarget = useRef<UploadTask | null>(null);
  const folderRef = useRef<DriveItem | null>(null);
  const sequence = useRef(0);
  folderRef.current = folder;
  const connected = !!status?.connected && !reauth;

  const navigate = useCallback(async (folderId: string, quiet = false) => {
    const turn = ++sequence.current;
    setPreview(null); setGridSuspended(true);
    if (!quiet) setLoading(true);
    try {
      const [info, page] = await Promise.all([api<ItemDetails>(`/items/${pathId(folderId)}`), api<FolderPage>(`/items/${pathId(folderId)}/children`)]);
      if (turn !== sequence.current) return;
      setFolder(info.item); setBreadcrumbs(info.breadcrumbs); setItems(page.items); setCursor(page.nextCursor); setSelected([]);
      if (!quiet) setQuery('');
    } catch (e) { message.error(friendlyError(e)); }
    finally { if (turn === sequence.current) { setLoading(false); setGridSuspended(false); } }
  }, [message]);
  const refresh = useCallback(() => {
    if (folderRef.current) void navigate(folderRef.current.id, true);
    void api<{ drive: Drive; root: DriveItem }>('/drive').then(data => setDrive(data.drive)).catch(() => undefined);
    setTreeVersion(value => value + 1);
  }, [navigate]);
  const resolveConflict = useCallback((name: string) => new Promise<ConflictBehavior | null>(resolve => {
    const dialog = modal.confirm({ title: '目标目录已有同名项目', icon: <FileAddOutlined style={{ color: '#e7a52c' }} />, content: <p className="conflict-name">{name}<br /><span className="muted">请选择这次上传的处理方式。</span></p>, onCancel: () => resolve(null), footer: () => <Space wrap style={{ justifyContent: 'flex-end', width: '100%', marginTop: 20 }}><Button onClick={() => { resolve(null); dialog.destroy(); }}>跳过</Button><Button onClick={() => { resolve('rename'); dialog.destroy(); }}>保留两份</Button><Button type="primary" danger onClick={() => { resolve('replace'); dialog.destroy(); }}>覆盖文件</Button></Space> });
  }), [modal]);
  const uploads = useUploads(connected, refresh, resolveConflict);

  async function initialize() {
    setInitialError('');
    try { const result = await authStatus(); setStatus(result); setReauth(false); }
    catch (e) { setInitialError(friendlyError(e)); }
  }
  useEffect(() => {
    void initialize();
    const error = new URLSearchParams(window.location.search).get('authError');
    if (error) { message.error(error, 8); window.history.replaceState({}, '', window.location.pathname); }
    const listener = () => setReauth(true);
    window.addEventListener('odm-auth-required', listener);
    return () => window.removeEventListener('odm-auth-required', listener);
  }, []);
  useEffect(() => {
    if (!connected) return;
    let current = true;
    setLoading(true); setDriveError('');
    void api<{ drive: Drive; root: DriveItem }>('/drive').then(data => {
      if (!current) return;
      setDrive(data.drive); setRoot(data.root); void navigate(data.root.id);
    }).catch(e => { setLoading(false); setDriveError(friendlyError(e)); message.error(friendlyError(e)); });
    return () => { current = false; };
  }, [connected, navigate]);
  useEffect(() => {
    if (!root || !connected) return;
    let current = true;
    setTree([{ key: root.id, title: '所有文件', icon: <FolderOpenOutlined /> }]);
    void folderNodes(root.id).then(children => { if (current) setTree(old => replaceChildren(old, root.id, children)); }).catch(() => undefined);
    return () => { current = false; };
  }, [root?.id, connected, treeVersion]);

  function openItem(item: DriveItem) {
    if (item.folder) void navigate(item.id);
    else if (imageMime(item)) setPreview(item);
    else setDetails(item);
  }
  function download(item: DriveItem) {
    const link = document.createElement('a');
    link.href = `/api/items/${pathId(item.id)}/download`; link.download = item.name; link.target = '_blank'; link.rel = 'noopener'; link.click();
  }
  async function runBatch(action: 'move' | 'delete', targets: DriveItem[], parentId?: string) {
    setBatchBusy(true);
    try {
      const data = await api<{ results: BatchResult[] }>('/batch', { method: 'POST', body: json({ action, parentId, items: targets.map(i => ({ id: i.id, eTag: i.eTag })) }) });
      const failed = data.results.filter(i => !i.ok);
      if (failed.length) setReport({ action, items: targets, results: data.results, parentId });
      else { setReport(null); message.success(`已${action === 'delete' ? '删除' : '移动'} ${targets.length} 个项目`); }
      refresh();
      return failed.length === 0;
    } catch (e) { message.error(friendlyError(e)); return false; }
    finally { setBatchBusy(false); }
  }
  function confirmDelete(targets: DriveItem[]) {
    modal.confirm({ title: `删除${targets.length === 1 ? `“${targets[0].name}”` : `这 ${targets.length} 个项目`}？`, icon: <DeleteOutlined style={{ color: '#eb5e62' }} />, content: <><p>删除后会移入 OneDrive 回收站。</p>{targets.some(i => i.folder) && <p className="danger-text">所选文件夹及其中的全部内容会一起删除。</p>}</>, okText: '确认删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => { await runBatch('delete', targets); } });
  }
  function chooseReplacement(item: DriveItem) {
    modal.confirm({ title: `替换“${item.name}”的内容？`, content: '选择本机文件作为新内容，OneDrive 中的文件名保持不变。', okText: '选择替换文件', cancelText: '取消', onOk: () => { replacement.current = item; replaceInput.current?.click(); } });
  }
  async function saveEdit() {
    if (!editing || !folder) return;
    if (!editing.name.trim()) { message.warning('请输入名称'); return; }
    setSaving(true);
    try {
      if (editing.type === 'folder') await api(`/items/${pathId(folder.id)}/folders`, { method: 'POST', body: json({ name: editing.name }) });
      else await api(`/items/${pathId(editing.item!.id)}`, { method: 'PATCH', body: json({ name: editing.name, eTag: editing.item!.eTag }) });
      message.success(editing.type === 'folder' ? '文件夹已创建' : '已重命名'); setEditing(null); refresh();
    } catch (e) { message.error(friendlyError(e)); }
    finally { setSaving(false); }
  }
  async function logout() {
    if (uploads.busy) { message.info('请先暂停传输，等待当前分片完成后再退出'); return; }
    modal.confirm({ title: '断开 OneDrive 连接？', content: '将清除本应用的登录和授权缓存，未完成的上传任务也会取消。再次使用时需要重新授权。', okText: '断开连接', cancelText: '取消', onOk: async () => { setLoggingOut(true); try { await api('/auth/logout', { method: 'POST' }); setRoot(null); setFolder(null); setDrive(null); setItems([]); await initialize(); } catch (e) { message.error(friendlyError(e)); } finally { setLoggingOut(false); } } });
  }
  function rowMenu(item: DriveItem) {
    return { items: [
      ...(!item.folder ? [{ key: 'download', label: '下载文件', icon: <DownloadOutlined /> }, { key: 'replace', label: '替换文件内容', icon: <UploadOutlined /> }] : []),
      { key: 'rename', label: '重命名', icon: <FileAddOutlined /> }, { key: 'move', label: '移动到…', icon: <SwapOutlined /> },
      { key: 'details', label: '详细信息', icon: <InfoCircleOutlined /> }, { type: 'divider' as const }, { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true }
    ], onClick: ({ key }: { key: string }) => { if (key === 'download') download(item); if (key === 'replace') chooseReplacement(item); if (key === 'rename') setEditing({ type: 'rename', name: item.name, item }); if (key === 'move') setMoving([item]); if (key === 'details') setDetails(item); if (key === 'delete') confirmDelete([item]); } };
  }
  const selectedItems = items.filter(i => selected.includes(i.id));
  const filtered = items.filter(i => i.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const foldersCount = items.filter(i => i.folder).length;
  const columns: ColumnsType<DriveItem> = [
    { title: '名称', dataIndex: 'name', key: 'name', sorter: (a, b) => Number(!!b.folder) - Number(!!a.folder) || a.name.localeCompare(b.name, 'zh-CN'), defaultSortOrder: 'ascend', render: (_, item) => <div className="file-cell"><FileIcon item={item} /><button className="file-name" title={item.name} onClick={() => openItem(item)}>{item.name}</button></div> },
    { title: '大小', dataIndex: 'size', key: 'size', width: 125, sorter: (a, b) => a.size - b.size, render: (_, item) => <span className="secondary-cell">{item.folder ? '—' : formatBytes(item.size)}</span>, responsive: ['sm'] },
    { title: '修改时间', dataIndex: 'lastModifiedDateTime', key: 'modified', width: 205, sorter: (a, b) => (a.lastModifiedDateTime || '').localeCompare(b.lastModifiedDateTime || ''), render: date => <span className="secondary-cell">{formatDate(date)}</span>, responsive: ['md'] },
    { title: '类型', key: 'type', width: 110, render: (_, item) => <span className="secondary-cell">{item.folder ? '文件夹' : item.name.includes('.') ? item.name.split('.').pop()?.toUpperCase() : '文件'}</span>, responsive: ['lg'] },
    { title: '', key: 'actions', width: 55, render: (_, item) => <Dropdown menu={rowMenu(item)} trigger={['click']}><Button type="text" icon={<EllipsisOutlined />} aria-label={`${item.name} 的操作`} /></Dropdown> }
  ];
  const activeUploads = uploads.tasks.filter(i => ['pending', 'uploading', 'paused', 'failed'].includes(i.state)).length;
  const quotaPercent = drive?.quota?.total ? Math.min(100, (drive.quota.used || 0) / drive.quota.total * 100) : 0;

  if (!status && !initialError) return <div className="initial-loading"><Spin indicator={<LoadingOutlined style={{ fontSize: 30 }} spin />} /><p>正在打开工作台</p></div>;
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" onClick={event => { event.preventDefault(); setNav('files'); }}><span className="brand-mark"><CloudOutlined /></span><span><strong>OneDrive</strong><small>MANAGER</small></span></a>
      <div className="workspace-label">我的工作台 <span>LOCAL</span></div>
      <nav className="main-nav" aria-label="主导航">
        <button className={nav === 'files' ? 'active' : ''} onClick={() => setNav('files')}><FolderOpenOutlined /><span>我的文件</span>{connected && <span className="nav-dot" />}</button>
        <button className={nav === 'transfers' ? 'active' : ''} onClick={() => setNav('transfers')}><SwapOutlined /><span>传输任务</span>{activeUploads > 0 && <Badge count={activeUploads} size="small" color="#1765e8" />}</button>
        <button className={nav === 'settings' ? 'active' : ''} onClick={() => setNav('settings')}><SettingOutlined /><span>连接设置</span></button>
      </nav>
      {connected && root && <div className="directory-section"><div className="section-label">文件目录</div><Tree key={treeVersion} showIcon blockNode treeData={tree} defaultExpandedKeys={[root.id]} selectedKeys={folder ? [folder.id] : []} onSelect={keys => { if (keys[0]) { setNav('files'); void navigate(String(keys[0])); } }} loadData={async node => { if (node.children) return; const children = await folderNodes(String(node.key)); setTree(old => replaceChildren(old, node.key, children)); }} /></div>}
      <div className="sidebar-bottom">
        <div className="storage-card"><div className="storage-heading"><CloudServerOutlined /><span>云端存储</span>{connected && <span className="tiny-dot" />}</div>{connected ? <><Progress percent={quotaPercent} showInfo={false} strokeColor="#3479ec" trailColor="#e7edf7" size="small" /><p><strong>{formatBytes(drive?.quota?.used)}</strong> / {formatBytes(drive?.quota?.total)}</p></> : <p>连接 OneDrive 后查看存储空间</p>}</div>
        <div className="local-note"><SafetyCertificateOutlined /><span>本机运行 · 授权加密保存</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-location"><CloudOutlined /><span>个人云盘</span><span className="topbar-slash">/</span><strong>{nav === 'files' ? '文件管理' : nav === 'transfers' ? '传输任务' : '连接设置'}</strong></div><div className="topbar-account"><Tag bordered={false} color={connected ? 'success' : 'default'}><span className={`status-dot ${connected ? 'online' : ''}`} />{connected ? '已连接' : '未连接'}</Tag>{connected && status?.account ? <Dropdown menu={{ items: [{ key: 'settings', label: '连接设置', icon: <SettingOutlined /> }, { key: 'logout', label: '断开连接', icon: <LogoutOutlined />, danger: true }], onClick: ({ key }) => key === 'logout' ? void logout() : setNav('settings') }}><button className="account-button"><Avatar size={30} style={{ background: '#e8f0ff', color: '#1765e8' }}>{status.account.name.slice(0, 1).toUpperCase()}</Avatar><span>{status.account.name}</span></button></Dropdown> : <Avatar size={30} icon={<CloudOutlined />} style={{ background: '#f0f3f9', color: '#9ca9bf' }} />}</div></header>
      <main className="main-content">
        <div className="page-heading"><div><div className="eyebrow">ONEDRIVE WORKSPACE</div><h1>{nav === 'files' ? '我的文件' : nav === 'transfers' ? '传输任务' : '连接设置'}</h1><p>{nav === 'files' ? '有序管理每一份文件，让云端触手可及。' : nav === 'transfers' ? '查看上传进度，随时暂停与继续。' : '管理微软账号授权与本机连接配置。'}</p></div><div className="page-hint"><SafetyCertificateOutlined /> 你的文件，由你掌控</div></div>
        {initialError && <Alert type="error" title="无法打开本地服务" description={initialError} showIcon action={<Button onClick={() => void initialize()}>重试</Button>} />}
        {connected && nav === 'files' && driveError && <Alert type="error" title="暂时无法读取云盘" description={driveError} showIcon action={<Button onClick={() => window.location.reload()}>重新加载</Button>} style={{ marginBottom: 20 }} />}
        {reauth && <Alert type="warning" title="需要重新确认授权" description="当前授权已失效，请重新连接 OneDrive 后继续。" showIcon style={{ marginBottom: 20 }} />}
        {nav === 'settings' && status ? <ConnectionSettings status={{ ...status, connected }} account={connected ? status.account : null} onRefresh={initialize} onLogout={logout} loggingOut={loggingOut} /> : !connected ? status && <ConnectPanel status={status} onSettings={() => setNav('settings')} /> : nav === 'transfers' ? <>
          <div className="transfer-summary"><div><span className="summary-icon blue"><CloudUploadOutlined /></span><span><strong>{uploads.tasks.filter(t => t.state === 'uploading').length}</strong><small>正在上传</small></span></div><div><span className="summary-icon amber"><PauseCircleOutlined /></span><span><strong>{uploads.tasks.filter(t => ['paused', 'failed', 'pending'].includes(t.state)).length}</strong><small>等待继续</small></span></div><div><span className="summary-icon green"><CheckOutlined /></span><span><strong>{uploads.tasks.filter(t => t.state === 'completed').length}</strong><small>已完成</small></span></div></div>
          <div className="panel"><div className="panel-heading"><h3>上传记录 <span>{uploads.tasks.length}</span></h3><Button icon={<ReloadOutlined />} onClick={() => void uploads.load()}>刷新</Button></div><div className="transfer-tip"><InfoCircleOutlined /> 刷新页面后，选择原文件即可继续未完成的任务。最多同时上传 3 个文件。</div>{uploads.tasks.length ? <div className="task-list">{uploads.tasks.map(task => <div className="task-row" key={task.id}><FileIcon item={{ name: task.name }} /><div className="task-content"><div className="task-title"><strong title={task.name}>{task.name}</strong><Tag color={task.state === 'completed' ? 'success' : task.state === 'failed' || task.state === 'expired' ? 'error' : task.state === 'uploading' ? 'processing' : 'default'}>{stateNames[task.state]}</Tag></div><Progress percent={task.size ? Math.round(task.offset / task.size * 100) : task.state === 'completed' ? 100 : 0} status={task.state === 'failed' || task.state === 'expired' ? 'exception' : task.state === 'completed' ? 'success' : 'normal'} size="small" /><div className="task-meta"><span>{formatBytes(task.offset)} / {formatBytes(task.size)}</span><span>{formatDate(task.createdAt)}</span></div>{task.error && <p className="task-error">{task.error}</p>}</div><Space className="task-actions">{['uploading', 'pending'].includes(task.state) && <Tooltip title="暂停（当前分片完成后生效）"><Button aria-label={`暂停 ${task.name}`} icon={<PauseCircleOutlined />} onClick={() => void uploads.pause(task).catch(e => message.error(friendlyError(e)))} /></Tooltip>}{['paused', 'failed'].includes(task.state) && <Button icon={<PlayCircleOutlined />} onClick={() => { resumeTarget.current = task; resumeInput.current?.click(); }}>选择文件继续</Button>}{!['completed', 'cancelled', 'expired'].includes(task.state) && <Tooltip title="取消任务"><Button aria-label={`取消 ${task.name}`} type="text" danger icon={<DeleteOutlined />} onClick={() => void uploads.cancel(task).catch(e => message.error(friendlyError(e)))} /></Tooltip>}</Space></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无上传任务" style={{ padding: 55 }}><Button type="primary" onClick={() => { setNav('files'); fileInput.current?.click(); }}>上传第一个文件</Button></Empty>}</div>
        </> : <>
          <div className="file-stats"><span><FolderFilled /> {foldersCount} 个文件夹</span><span><FileAddOutlined /> {items.length - foldersCount} 个文件</span><span className="stats-note">{cursor ? '当前已加载的项目' : '当前目录'}</span></div>
          <div className={`panel files-panel ${dragging ? 'dragging' : ''}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (folder) void uploads.addFiles(Array.from(event.dataTransfer.files), folder.id); }}>
            {dragging && <div className="drop-overlay"><CloudUploadOutlined /><strong>松开以上传到当前文件夹</strong><span>支持多个文件与大文件分片上传</span></div>}
            <div className="files-toolbar"><Space wrap><Button type="primary" icon={<UploadOutlined />} loading={uploads.adding} disabled={!folder} onClick={() => fileInput.current?.click()}>上传文件</Button><Button icon={<FolderAddOutlined />} disabled={!folder} onClick={() => setEditing({ type: 'folder', name: '' })}>新建文件夹</Button>{selected.length > 0 && <><Button icon={<SwapOutlined />} loading={batchBusy} onClick={() => setMoving(selectedItems)}>移动</Button><Button danger icon={<DeleteOutlined />} disabled={batchBusy} onClick={() => confirmDelete(selectedItems)}>删除</Button></>}</Space><div className="toolbar-right"><Space.Compact><Button aria-label="文本列表" aria-pressed={layout === 'list'} type={layout === 'list' ? 'primary' : 'default'} icon={<UnorderedListOutlined />} onClick={() => setLayout('list')} /><Button aria-label="网格布局" aria-pressed={layout === 'grid'} type={layout === 'grid' ? 'primary' : 'default'} icon={<AppstoreOutlined />} onClick={() => setLayout('grid')} /></Space.Compact><Input allowClear prefix={<SearchOutlined />} placeholder="筛选已加载的文件" aria-label="筛选文件" value={query} onChange={e => setQuery(e.target.value)} /><Tooltip title="刷新目录"><Button aria-label="刷新目录" icon={<ReloadOutlined spin={loading} />} onClick={() => { if (folder) void navigate(folder.id); }} /></Tooltip></div></div>
            <div className="path-bar"><AntBreadcrumb items={breadcrumbs.map((crumb, i) => ({ title: <button className={`breadcrumb-link ${i === breadcrumbs.length - 1 ? 'current' : ''}`} onClick={() => void navigate(crumb.id)}>{i === 0 && <FolderOutlined />} {crumb.name}</button> }))} /><span>{selected.length ? `已选择 ${selected.length} 项` : `${items.length} 个项目${cursor ? '+' : ''}`}</span></div>
            {layout === 'grid' ? gridSuspended ? <div className="grid-empty"><Spin /></div> : <FileGrid key={folder?.id} items={filtered} selected={selected} onSelect={setSelected} onOpen={openItem} menu={rowMenu} empty={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? '没有匹配的文件' : '文件夹还是空的'}>{!query && <Button type="primary" onClick={() => fileInput.current?.click()}>上传文件</Button>}</Empty>} /> : (
            <Table<DriveItem> rowKey="id" columns={columns} dataSource={filtered} pagination={false} loading={loading} rowSelection={{ selectedRowKeys: selected, onChange: setSelected, columnWidth: 48, getCheckboxProps: item => ({ 'aria-label': `选择 ${item.name}` }), getTitleCheckboxProps: () => ({ 'aria-label': '选择当前列表全部项目' }) }} onRow={item => ({ onDoubleClick: () => { if (item.folder) void navigate(item.id); } })} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? '没有匹配的文件' : '文件夹还是空的'}><p className="empty-description">{query ? '试试其他名称，或加载更多项目。' : '上传文件或新建文件夹，开始整理你的云盘。'}</p>{!query && <Button type="primary" icon={<UploadOutlined />} onClick={() => fileInput.current?.click()}>上传文件</Button>}</Empty> }} />
            )}
            <div className="table-footer"><span><CheckCircleFilled /> 与 OneDrive 实时连接</span>{cursor && <Button size="small" loading={loading} onClick={async () => { if (!folder) return; const currentId = folder.id; setLoading(true); try { const page = await api<FolderPage>(`/items/${pathId(folder.id)}/children?cursor=${encodeURIComponent(cursor)}`); if (folderRef.current?.id !== currentId) return; setItems(old => [...old, ...page.items.filter(i => !old.some(j => j.id === i.id))]); setCursor(page.nextCursor); } catch (e) { message.error(friendlyError(e)); } finally { setLoading(false); } }}>加载更多 <ArrowDownOutlined /></Button>}<span>拖拽文件到此处即可上传</span></div>
          </div>
          {activeUploads > 0 && <button className="transfer-banner" onClick={() => setNav('transfers')}><span><CloudUploadOutlined /><strong>{activeUploads} 个上传任务</strong><span>查看进度与传输详情</span></span><ArrowRightOutlined /></button>}
        </>}
        <footer className="page-footer"><span>Simple OneDrive Manager</span><span>简单管理，专注文件。</span></footer>
      </main>
    </div>
    <input hidden ref={fileInput} type="file" multiple onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (folder) void uploads.addFiles(files, folder.id); }} />
    <input hidden ref={replaceInput} type="file" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; const target = replacement.current; if (target?.parentReference?.id) void uploads.addFiles(files, target.parentReference.id, target); }} />
    <input hidden ref={resumeInput} type="file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file && resumeTarget.current) uploads.resume(resumeTarget.current, file); }} />
    <Modal open={!!editing} title={editing?.type === 'folder' ? '新建文件夹' : '重命名'} okText={editing?.type === 'folder' ? '创建' : '保存'} cancelText="取消" confirmLoading={saving} onCancel={() => setEditing(null)} onOk={() => void saveEdit()} destroyOnHidden><label className="field-label" htmlFor="edit-name">{editing?.type === 'folder' ? '文件夹名称' : '名称'}</label><Input id="edit-name" autoFocus maxLength={255} placeholder="请输入名称" value={editing?.name || ''} onChange={event => setEditing(old => old && { ...old, name: event.target.value })} onPressEnter={() => { if (!saving) void saveEdit(); }} /><p className="form-help">不能使用 / \ : * ? &quot; &lt; &gt; |，不能以空格或句点结尾。</p></Modal>
    {moving && root && <FolderPicker root={root} excluded={moving.filter(i => i.folder).map(i => i.id)} onCancel={() => setMoving(null)} onSelect={async parentId => { await runBatch('move', moving, parentId); setMoving(null); }} />}
    {connected && nav === 'files' && preview && <ImagePreview key={`${preview.id}:${preview.eTag || ''}`} item={preview} onClose={() => setPreview(null)} onDownload={() => download(preview)} />}
    <Drawer title="详细信息" open={!!details} onClose={() => setDetails(null)} size={410}><div className="detail-preview">{details && <FileIcon item={details} large />}<h3>{details?.name}</h3></div>{details && <Descriptions column={1} size="small" items={[{ key: 'type', label: '类型', children: details.folder ? '文件夹' : details.file?.mimeType || '文件' }, { key: 'size', label: '大小', children: formatBytes(details.size) }, { key: 'modified', label: '修改时间', children: formatDate(details.lastModifiedDateTime) }, ...(details.folder ? [{ key: 'count', label: '子项目', children: `${details.folder.childCount} 项` }] : []), { key: 'path', label: '所在目录', children: breadcrumbs.map(i => i.name).join(' / ') }]} />}{details?.webUrl && <Button block icon={<LinkOutlined />} style={{ marginTop: 24 }} onClick={() => { if (details.webUrl?.startsWith('https://')) window.open(details.webUrl, '_blank', 'noopener,noreferrer'); }}>在 OneDrive 中打开</Button>}</Drawer>
    <Modal open={!!report} title="部分项目未能完成操作" onCancel={() => setReport(null)} footer={<Space><Button onClick={() => setReport(null)}>关闭</Button><Button type="primary" loading={batchBusy} onClick={() => { if (report) { const failed = new Set(report.results.filter(i => !i.ok).map(i => i.id)); void runBatch(report.action, report.items.filter(i => failed.has(i.id)), report.parentId); } }}>仅重试失败项</Button></Space>}><p className="muted">成功项目已完成，仅列出需要处理的项目。</p><div className="batch-errors">{report?.results.filter(i => !i.ok).map(result => <div key={result.id}><strong>{report.items.find(i => i.id === result.id)?.name}</strong><p>{result.error}</p></div>)}</div></Modal>
  </div>;
}

function ConnectPanel({ status, onSettings }: { status: AuthStatus; onSettings: () => void }) {
  return <>
    <section className="connect-panel"><div className="connect-copy"><Tag bordered={false} color="blue">你的轻量云盘工作台</Tag><h2>连接云端，<br />让文件管理更简单。</h2><p>通过微软账号安全授权，在熟悉的管理界面中<br className="desktop-break" />浏览、上传、整理每一份重要文件。</p><Space wrap><Button type="primary" size="large" icon={<LinkOutlined />} disabled={!status.configured || !!status.loginIssue} href="/api/auth/login">连接 OneDrive <ArrowRightOutlined /></Button><Button size="large" onClick={onSettings}>配置指引</Button></Space><div className="connect-footnote"><SafetyCertificateOutlined /> 文件保存在 OneDrive，授权信息在本机加密保存</div></div><div className="cloud-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="floating-file float-one"><FileAddOutlined /></span><span className="floating-file float-two"><FolderFilled /></span><span className="floating-file float-three"><FileAddOutlined /></span><div className="cloud-disc"><CloudOutlined /></div><div className="cloud-label"><span className="tiny-dot" /> Microsoft OneDrive</div><div className="cloud-lock"><SafetyCertificateOutlined /></div></div></section>
    {status.loginIssue && <Alert className="config-alert" type="warning" showIcon title="当前地址需要调整授权配置" description={status.loginIssue} action={<Button onClick={onSettings}>查看连接设置</Button>} />}
    {!status.configured && <Alert className="config-alert" type="info" showIcon title="完成应用配置，即可连接 OneDrive" description="首次使用需要注册一个微软应用，并在本机填写应用 ID 和密钥。配置完成后即可通过微软页面登录授权。" action={<Button onClick={onSettings}>查看配置步骤 <ArrowRightOutlined /></Button>} />}
    <div className="feature-grid"><Feature icon={<FolderOpenOutlined />} tone="blue" title="文件井井有条" text="浏览目录、移动和重命名，轻松整理云端文件。" /><Feature icon={<CloudUploadOutlined />} tone="purple" title="大文件，稳稳上传" text="分片传输与进度记录，支持暂停后继续上传。" /><Feature icon={<SafetyCertificateOutlined />} tone="green" title="本机掌握授权" text="通过微软官方登录授权，密钥留在你的设备。" /></div>
    <div className="getting-started"><span className="section-label">三步开始</span><div><span><b>01</b> 配置微软应用</span><ArrowRightOutlined /><span><b>02</b> 连接 OneDrive</span><ArrowRightOutlined /><span><b>03</b> 开始管理文件</span></div></div>
  </>;
}
function Feature({ icon, tone, title, text }: { icon: React.ReactNode; tone: string; title: string; text: string }) { return <div className="feature-card"><span className={`feature-icon ${tone}`}>{icon}</span><h3>{title}</h3><p>{text}</p></div>; }
function ConnectionSettings({ status, account, onRefresh, onLogout, loggingOut }: { status: AuthStatus; account: Account | null; onRefresh: () => Promise<void>; onLogout: () => Promise<void>; loggingOut: boolean }) {
  const { message } = AntApp.useApp();
  return <div className="settings-grid"><div className="panel settings-panel"><div className="panel-heading"><h3>OneDrive 连接</h3><Tag color={status.connected ? 'success' : status.configured ? 'blue' : 'warning'}>{status.connected ? '已连接' : status.configured ? '等待授权' : '待配置'}</Tag></div><div className="settings-inner">{account ? <><div className="connected-account"><Avatar size={52} style={{ background: '#e8f0ff', color: '#1765e8' }}>{account.name.slice(0, 1).toUpperCase()}</Avatar><div><strong>{account.name}</strong><p>{account.username}</p></div></div><Alert type="success" title="已通过微软账号安全授权" showIcon /><Button danger icon={<DisconnectOutlined />} loading={loggingOut} onClick={() => void onLogout()} style={{ marginTop: 20 }}>断开连接</Button></> : <><p className="muted">连接个人微软账号或国际版 Microsoft 365 工作 / 学校账号。</p><Button type="primary" icon={<LinkOutlined />} href="/api/auth/login" disabled={!status.configured || !!status.loginIssue}>连接 OneDrive</Button></>}<Divider />{status.loginIssue && <Alert type="warning" showIcon title="授权地址需要配置" description={status.loginIssue} style={{ marginBottom: 20 }} />}<Descriptions column={1} size="small" items={[{ key: 'app', label: '应用配置', children: status.configured ? <Tag color="success">已填写</Tag> : <span>缺少 {status.missing.join('、')}</span> }, { key: 'origin', label: '页面地址', children: status.origin }, { key: 'callback', label: '授权回调', children: <span className="setting-url">{status.redirectUri}</span> }]} /></div></div><div className="panel settings-panel"><div className="panel-heading"><h3>首次配置指引</h3><SafetyCertificateOutlined /></div><div className="settings-inner"><div className="setup-step"><span>1</span><div><h4>注册微软应用</h4><p>在 Microsoft Entra 应用注册中，新建支持“任何组织目录和个人 Microsoft 账号”的应用。</p><a href="https://learn.microsoft.com/entra/identity-platform/quickstart-register-app" target="_blank" rel="noreferrer">查看微软注册说明 <LinkOutlined /></a></div></div><div className="setup-step"><span>2</span><div><h4>添加 Web 回调与权限</h4><p>平台选择 <strong>Web</strong>，回调地址填写：</p><div className="copy-box"><code>{status.redirectUri}</code><Tooltip title="复制回调地址"><Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制回调地址" onClick={() => void copyText(status.redirectUri).then(() => message.success('已复制')).catch(() => message.error('复制失败，请手动复制'))} /></Tooltip></div><p>添加委托权限 <code>User.Read</code>、<code>Files.ReadWrite</code>，创建客户端密钥并保存密钥值。</p></div></div><div className="setup-step"><span>3</span><div><h4>填写本机配置并重启</h4><p>在项目的 <code>.env</code> 文件填写 <code>MS_CLIENT_ID</code> 和 <code>MS_CLIENT_SECRET</code>，运行 <code>npm run restart</code>。</p><Button icon={<ReloadOutlined />} onClick={() => void onRefresh()}>重新检查配置</Button></div></div><div className="settings-tip"><InfoCircleOutlined /> 局域网设备登录请使用同一 HTTPS 域名的页面地址和授权回调。企业账号可能需要组织管理员批准授权。</div></div></div></div>;
}
