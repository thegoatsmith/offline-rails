// Talking to the builder worker, and deciding when not to.
//
// `null` means the worker is unavailable and the caller should do the work
// inline, exactly as the app did before there was one. An `error` is a real
// failure and must be shown to the user rather than silently retried.

import type { StepName, StepState, WorkerJob, WorkerMessage } from './types.ts';

export interface WorkerResult {
  type?: 'done';
  id?: string;
  changed?: boolean;
  error?: string;
}

let workerUnavailable = false;

export function runInWorker(
  job: WorkerJob,
  onStep?: (name: StepName, state: StepState) => void,
  onProgress?: (text: string) => void,
): Promise<WorkerResult | null> {
  if (workerUnavailable || typeof Worker === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      // Built as its own entrypoint to a stable filename, so this path is the
      // same in dev and in the bundle and the service worker can precache it.
      worker = new Worker('/builder.worker.js', { type: 'module' });
    } catch {
      workerUnavailable = true;
      resolve(null);
      return;
    }

    let ready = false;
    let settled = false;
    const finish = (value: WorkerResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshake);
      worker.terminate();
      resolve(value);
    };

    // A browser that ignores `type: 'module'` fails on the first import rather
    // than throwing above, so trust the worker only once it has said hello.
    const handshake = setTimeout(() => {
      if (!ready) {
        workerUnavailable = true;
        finish(null);
      }
    }, 4000);

    worker.onerror = () => {
      if (!ready) workerUnavailable = true;
      finish(null);
    };

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'ready') {
        ready = true;
        clearTimeout(handshake);
        worker.postMessage(job);
      } else if (m.type === 'step') onStep?.(m.name, m.state);
      else if (m.type === 'progress') onProgress?.(m.text);
      else if (m.type === 'done') finish(m);
      else if (m.type === 'error') finish({ error: m.message });
    };
  });
}
