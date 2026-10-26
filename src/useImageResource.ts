import { useEffect, useState } from 'react';
import { friendlyError, imageBlob } from './api';
import { queueThumbnail } from './imageRequests';

export function useImageResource(path: string | null, queued = false, original = false) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ path: '', src: '', error: '', loading: false });
  useEffect(() => {
    if (!path) { setState({ path: '', src: '', error: '', loading: false }); return; }
    const controller = new AbortController();
    let objectUrl = '';
    setState({ path, src: '', error: '', loading: true });
    const load = () => imageBlob(path, controller.signal);
    void (queued ? queueThumbnail(load, controller.signal) : load()).then(async blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.src = objectUrl;
      try { await image.decode(); }
      catch { throw new Error(original ? '浏览器无法显示此原图格式，请使用“下载文件”在本机查看。' : '缩略图无法显示，请重试。'); }
      if (!controller.signal.aborted) setState({ path, src: objectUrl, error: '', loading: false });
    }).catch(error => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (!controller.signal.aborted) setState({ path, src: '', error: friendlyError(error), loading: false });
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, attempt, queued, original]);
  const current = state.path === path ? state : { src: '', error: '', loading: !!path };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}
