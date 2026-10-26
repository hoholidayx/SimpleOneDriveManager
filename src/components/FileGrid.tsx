import { useEffect, useRef, useState, type Key, type ReactNode } from 'react';
import { Button, Checkbox, Dropdown, Spin, type MenuProps } from 'antd';
import { EllipsisOutlined } from '@ant-design/icons';
import type { DriveItem } from '../../shared/types';
import { imageMime } from '../../shared/images';
import { formatBytes, pathId } from '../api';
import { useImageResource } from '../useImageResource';
import { FileIcon } from './FileIcon';

function Thumbnail({ item }: { item: DriveItem }) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const image = useImageResource(visible ? `/items/${pathId(item.id)}/thumbnail?size=medium` : null, true);
  return <span ref={element} className="grid-thumbnail">
    {image.src ? <img src={image.src} alt="" /> : <FileIcon item={item} large />}
    {image.loading && <Spin size="small" />}
    {image.error && <span className="thumbnail-unavailable" title={image.error}>暂无缩略图</span>}
  </span>;
}

interface Props {
  items: DriveItem[]; selected: Key[]; onSelect: (keys: Key[]) => void;
  onOpen: (item: DriveItem) => void; menu: (item: DriveItem) => MenuProps; empty: ReactNode;
}
export function FileGrid({ items, selected, onSelect, onOpen, menu, empty }: Props) {
  const sorted = [...items].sort((a, b) => Number(!!b.folder) - Number(!!a.folder) || a.name.localeCompare(b.name, 'zh-CN'));
  const selectedCount = items.filter(item => selected.includes(item.id)).length;
  return <div className="grid-view">
    {!!items.length && <div className="grid-selection"><Checkbox checked={selectedCount === items.length} indeterminate={selectedCount > 0 && selectedCount < items.length} onChange={event => onSelect(event.target.checked ? [...new Set([...selected, ...items.map(item => item.id)])] : selected.filter(key => !items.some(item => item.id === key)))}>选择当前网格全部项目</Checkbox></div>}
    {items.length ? <div className="file-grid">{sorted.map(item => <article className={`file-card ${selected.includes(item.id) ? 'selected' : ''}`} key={`${item.id}:${item.eTag || item.lastModifiedDateTime || ''}`}>
      <div className="card-actions"><Checkbox aria-label={`选择 ${item.name}`} checked={selected.includes(item.id)} onChange={event => onSelect(event.target.checked ? [...selected, item.id] : selected.filter(key => key !== item.id))} /><Dropdown menu={menu(item)} trigger={['click']}><Button type="text" icon={<EllipsisOutlined />} aria-label={`${item.name} 的操作`} /></Dropdown></div>
      <button className="card-open" onClick={() => onOpen(item)} aria-label={`打开 ${item.name}`}>
        {imageMime(item) ? <Thumbnail item={item} /> : <span className="grid-thumbnail"><FileIcon item={item} large /></span>}
        <span className="card-name" title={item.name}>{item.name}</span>
        <span className="card-meta">{item.folder ? '文件夹' : formatBytes(item.size)}</span>
      </button>
    </article>)}</div> : <div className="grid-empty">{empty}</div>}
  </div>;
}
