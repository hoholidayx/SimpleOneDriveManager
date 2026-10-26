import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { CHUNK_SIZE, type ConflictBehavior, type DriveItem, type UploadTask } from '../shared/types';
import { api, ApiError, friendlyError, json, pathId } from './api';

type Job = { task: UploadTask; file: File; desired: 'run' | 'pause' | 'cancel' };
export function useUploads(connected: boolean, onComplete: () => void, conflict: (name: string) => Promise<ConflictBehavior | null>) {
  const { message } = App.useApp();
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [adding, setAdding] = useState(false);
  const jobs = useRef(new Map<string, Job>());
  const running = useRef(new Set<string>());
  const enabled = useRef(connected);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  enabled.current = connected;
  const update = useCallback((task: UploadTask) => setTasks(old => [task, ...old.filter(i => i.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt)), []);
  const load = useCallback(async () => {
    if (!enabled.current) return;
    try {
      const { tasks: loaded } = await api<{ tasks: UploadTask[] }>('/uploads');
      setTasks(old => loaded.map(task => running.current.has(task.id) ? old.find(i => i.id === task.id) || task : task));
    } catch (e) { message.error(friendlyError(e)); }
  }, [message]);
  useEffect(() => { if (connected) void load(); else { setTasks([]); for (const job of jobs.current.values()) job.desired = 'pause'; } }, [connected, load]);

  async function execute(job: Job) {
    const { id } = job.task;
    running.current.add(id);
    try {
      let task = await api<UploadTask>(`/uploads/${pathId(id)}?reconcile=1`);
      update({ ...task, state: task.state === 'completed' ? 'completed' : 'uploading' });
      if (task.state === 'expired') throw new Error(task.error || '上传会话已过期，请重新上传');
      while (task.state !== 'completed' && job.desired === 'run' && enabled.current) {
        const end = Math.min(task.offset + CHUNK_SIZE, task.size);
        const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
        if (task.size > CHUNK_SIZE) headers['Content-Range'] = `bytes ${task.offset}-${end - 1}/${task.size}`;
        task = await api<UploadTask>(`/uploads/${pathId(id)}/content`, { method: 'PUT', headers, body: job.file.slice(task.offset, end) });
        job.task = task;
        update(task);
      }
      if (task.state === 'completed') { message.success(`${task.name} 上传完成`); completeRef.current(); }
      else if (job.desired === 'cancel') update(await api<UploadTask>(`/uploads/${pathId(id)}`, { method: 'DELETE' }));
      else if (enabled.current) update(await api<UploadTask>(`/uploads/${pathId(id)}/pause`, { method: 'POST' }));
    } catch (e) {
      update({ ...job.task, state: 'failed', error: friendlyError(e) });
      message.error(`${job.task.name}：${friendlyError(e)}`);
    } finally { running.current.delete(id); jobs.current.delete(id); pump(); }
  }
  function pump() {
    if (!enabled.current) return;
    for (const [id, job] of jobs.current) {
      if (running.current.size >= 3) break;
      if (!running.current.has(id) && job.desired === 'run') void execute(job);
    }
  }
  function schedule(task: UploadTask, file: File) {
    if (jobs.current.has(task.id)) return;
    jobs.current.set(task.id, { task, file, desired: 'run' });
    update({ ...task, state: 'pending' });
    pump();
  }
  async function addFiles(files: File[], parentId: string, replacement?: DriveItem) {
    if (!files.length) return;
    setAdding(true);
    try {
      for (const file of files) {
        const body = { name: replacement?.name || file.name, sourceName: file.name, size: file.size, lastModified: file.lastModified, parentId, itemId: replacement?.id, eTag: replacement?.eTag };
        let task: UploadTask;
        try { task = await api<UploadTask>('/uploads', { method: 'POST', body: json(body) }); }
        catch (e) {
          if (e instanceof ApiError && e.status === 409 && !replacement) {
            const behavior = await conflict(file.name);
            if (!behavior) continue;
            try { task = await api<UploadTask>('/uploads', { method: 'POST', body: json({ ...body, conflict: behavior }) }); }
            catch (retryError) { message.error(`${file.name}：${friendlyError(retryError)}`); continue; }
          } else { message.error(`${file.name}：${friendlyError(e)}`); continue; }
        }
        schedule(task, file);
      }
    } catch (e) { message.error(friendlyError(e)); }
    finally { setAdding(false); }
  }
  async function pause(task: UploadTask) {
    const job = jobs.current.get(task.id);
    if (job) {
      job.desired = 'pause';
      update({ ...task, state: 'paused' });
      if (!running.current.has(task.id)) { jobs.current.delete(task.id); update(await api<UploadTask>(`/uploads/${pathId(task.id)}/pause`, { method: 'POST' })); }
    } else update(await api<UploadTask>(`/uploads/${pathId(task.id)}/pause`, { method: 'POST' }));
  }
  async function cancel(task: UploadTask) {
    const job = jobs.current.get(task.id);
    if (job && running.current.has(task.id)) { job.desired = 'cancel'; update({ ...task, error: '正在结束当前分片并取消…' }); return; }
    jobs.current.delete(task.id);
    update(await api<UploadTask>(`/uploads/${pathId(task.id)}`, { method: 'DELETE' }));
  }
  function resume(task: UploadTask, file: File) {
    if (file.name !== (task.sourceName || task.name)) { message.error('请选择与原任务同名的文件'); return; }
    if (file.size !== task.size || file.lastModified !== task.lastModified) { message.error('文件大小或修改时间与原任务不符，请重新上传'); return; }
    if (running.current.has(task.id)) { message.info('正在完成当前分片，请稍后继续'); return; }
    schedule(task, file);
  }
  return { tasks, adding, addFiles, pause, cancel, resume, load, busy: tasks.some(i => ['pending', 'uploading'].includes(i.state)) || adding };
}
