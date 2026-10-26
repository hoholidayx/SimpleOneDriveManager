// The limit covers the entire response body, not just the response headers.
export function createImageQueue(limit = 6) {
  let active = 0;
  const waiting: { start: () => void }[] = [];
  function pump() { while (active < limit && waiting.length) waiting.shift()!.start(); }
  return function enqueue<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = waiting.indexOf(job);
        if (index !== -1) { waiting.splice(index, 1); reject(signal.reason); }
      };
      const job = { start: () => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) { reject(signal.reason); return; }
        active++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
      } };
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', cancel, { once: true });
      waiting.push(job); pump();
    });
  };
}
export const queueThumbnail = createImageQueue();
