// builder.worker.js — fetching and folding a city, off the UI thread.
//
// Adding Moscow costs about 9.5 seconds of solid main-thread CPU: roughly
// 1.3 s decoding 223 MB of response text, 1.4 s in JSON.parse and 6.9 s in
// buildCity. Yielding between phases cannot fix the middle of that — JSON.parse
// runs to completion or not at all — so the whole chain moves here instead.
// Nothing renders from a worker, so it writes the finished city to IndexedDB
// and posts back only the stats; the page reads it back in about 25 ms, which
// is far cheaper than structured-cloning the network across the boundary.
//
// data.js needs no changes to run here: it touches indexedDB, fetch and Math,
// and never the DOM.

import { fetchNetwork, buildCity, migrateCity, store, emptyNetworkMessage } from './data.js';

const post = (msg) => self.postMessage(msg);
const step = (name, state) => post({ type: 'step', name, state });

async function build(job) {
  step('query', 'active');
  const raw = await fetchNetwork(job.bbox, job.modes, (text) => post({ type: 'progress', text }));

  step('query', 'done');
  step('build', 'active');
  post({ type: 'progress', text: `${raw.elements.length.toLocaleString()} map objects received.` });

  const city = buildCity(raw, { id: job.id, name: job.name, bbox: job.bbox, modes: job.modes });
  if (!city.stations.length) throw new Error(emptyNetworkMessage(raw));

  step('build', 'done');
  step('save', 'active');
  await store.saveCity(city);
  step('save', 'done');

  post({ type: 'done', id: city.id, stats: city.stats });
}

// Records written before the geometry was compacted are converted here too,
// for the same reason: Moscow's conversion is a couple of seconds of arithmetic
// and the map cannot be drawn until it finishes.
async function migrate(job) {
  const city = await store.getCity(job.id);
  if (!city) throw new Error('That city is no longer saved on this device.');
  const changed = migrateCity(city);
  if (changed) await store.saveCity(city);
  post({ type: 'done', id: job.id, changed });
}

self.onmessage = async (e) => {
  try {
    if (e.data.type === 'migrate') await migrate(e.data);
    else await build(e.data);
  } catch (err) {
    post({ type: 'error', message: err.message });
  }
};

// The page waits for this before trusting the worker; a browser without module
// workers never gets here and the page falls back to building inline.
post({ type: 'ready' });
