// builder.worker.ts — fetching and folding a city, off the UI thread.
//
// Adding Moscow used to cost about 12.7 seconds of solid main-thread CPU:
// roughly 2.7 s decoding and parsing 223 MB of response text and 9.8 s in
// buildCity. Yielding between phases cannot fix the middle of that — JSON.parse
// runs to completion or not at all — so the whole chain moves here instead.
// Nothing renders from a worker, so it writes the finished city to IndexedDB
// and posts back only the stats; the page reads it back in about 25 ms, which
// is far cheaper than structured-cloning the network across the boundary.
//
// Bounding the Overpass query to the requested box has since cut that 12.7 s to
// roughly a second, so this is belt and braces rather than load-bearing. It
// still keeps that second off the UI thread and still carries migrations.
//
// data.ts needs no changes to run here: it touches indexedDB, fetch and Math,
// and never the DOM.

import { buildCity, emptyNetworkMessage, fetchNetwork, migrateCity, store } from './data.ts';
import type { BuildJob, MigrateJob, StepName, WorkerJob, WorkerMessage } from './types.ts';

// DedicatedWorkerGlobalScope lives in lib.webworker, which cannot be loaded
// alongside lib.dom without the two definitions of `self` colliding. The worker
// only needs these two members, so declare them rather than drag in the lib.
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<WorkerJob>) => void) | null;
}

const ctx = self as unknown as WorkerScope;

const post = (msg: WorkerMessage) => ctx.postMessage(msg);
const step = (name: StepName, state: 'active' | 'done') => post({ type: 'step', name, state });

async function build(job: BuildJob): Promise<void> {
  step('query', 'active');
  const raw = await fetchNetwork(job.bbox, job.modes, (text) => post({ type: 'progress', text }));

  step('query', 'done');
  step('build', 'active');
  post({ type: 'progress', text: `${raw.elements.length.toLocaleString()} map objects received.` });

  const city = buildCity(raw, {
    id: job.id,
    name: job.name,
    bbox: job.bbox,
    modes: job.modes,
  });
  if (!city.stations.length) throw new Error(emptyNetworkMessage(raw));

  step('build', 'done');
  step('save', 'active');
  await store.saveCity(city);
  step('save', 'done');

  post({ type: 'done', id: city.id, stats: city.stats });
}

// Records written before the geometry was compacted are converted here too,
// for the same reason: the map cannot be drawn until it finishes.
async function migrate(job: MigrateJob): Promise<void> {
  const city = await store.getCity(job.id);
  if (!city) throw new Error('That city is no longer saved on this device.');
  const changed = migrateCity(city);
  if (changed) await store.saveCity(city);
  post({ type: 'done', id: job.id, changed });
}

ctx.onmessage = async (e: MessageEvent<WorkerJob>) => {
  try {
    if (e.data.type === 'migrate') await migrate(e.data);
    else await build(e.data as BuildJob);
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};

// The page waits for this before trusting the worker; a browser without module
// workers never gets here and the page falls back to building inline.
post({ type: 'ready' });
