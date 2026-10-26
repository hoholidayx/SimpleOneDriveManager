import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Spin, Tag } from 'antd';
import { DownloadOutlined, MinusOutlined, PlusOutlined } from '@ant-design/icons';
import type { DriveItem } from '../../shared/types';
import { formatBytes, pathId } from '../api';
import { useImageResource } from '../useImageResource';

export function ImagePreview({ item, onClose, onDownload }: { item: DriveItem; onClose: () => void; onDownload: () => void }) {
  const [loadOriginal, setLoadOriginal] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [actualSize, setActualSize] = useState(false);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 800, height: 500 });
  const [natural, setNatural] = useState({ width: 800, height: 500 });
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width && height) setBounds({ width, height });
    });
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);
  const large = useImageResource(`/items/${pathId(item.id)}/thumbnail?size=large`);
  const original = useImageResource(loadOriginal ? `/items/${pathId(item.id)}/original` : null, false, true);
  const src = original.src || large.src;
  const showingOriginal = !!original.src;
  const loading = original.loading || (!loadOriginal && large.loading);
  const error = original.error || (!showingOriginal && large.error);
  const scale = (actualSize ? 1 : Math.min(1, bounds.width / natural.width, bounds.height / natural.height)) * zoom;
  const originalStyle = showingOriginal ? { width: natural.width * scale, height: natural.height * scale } : undefined;
  return <Modal open title={<span className="preview-title">{item.name}</span>} onCancel={onClose} footer={null} width={960} centered destroyOnHidden className="image-preview-modal">
    <div className="preview-toolbar"><Space wrap><Tag color={showingOriginal ? 'green' : 'blue'}>{showingOriginal ? '原图' : '大缩略图'}</Tag><span className="muted">原文件 {formatBytes(item.size)}</span></Space><Space wrap>
      {showingOriginal && <><Button aria-label="缩小原图" icon={<MinusOutlined />} disabled={zoom <= 0.25} onClick={() => setZoom(value => Math.max(0.25, value - 0.25))} /><Button onClick={() => { setActualSize(value => !value); setZoom(1); }}>{actualSize ? '适应窗口' : '实际大小'}</Button><Button aria-label="放大原图" icon={<PlusOutlined />} disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.25))} /></>}
      {!showingOriginal && <Button type="primary" loading={original.loading} onClick={() => { if (loadOriginal) original.retry(); else setLoadOriginal(true); }}>查看原图</Button>}
      <Button icon={<DownloadOutlined />} onClick={onDownload}>下载文件</Button>
    </Space></div>
    {error && <Alert type="warning" showIcon title={error} action={<Button size="small" aria-label="重试预览" onClick={original.error ? original.retry : large.retry}>重试</Button>} />}
    <div ref={setViewport} className="preview-viewport">
      {src ? <div className="preview-canvas" style={originalStyle}><img key={src} src={src} alt={item.name} className={showingOriginal ? 'original-image' : 'fit-image'} style={originalStyle} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} /></div> : !loading && <span className="muted">暂无可显示的预览</span>}
      {loading && <div className="preview-loading" role="status"><Spin /><span>{original.loading ? '正在加载原图…' : '正在加载大缩略图…'}</span></div>}
    </div>
  </Modal>;
}
