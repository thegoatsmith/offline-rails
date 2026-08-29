import { store, geocode, fetchNetwork, buildCity, migrateCity, needsMigration, emptyNetworkMessage } from './data.js';
import { route as findRoute, nearest } from './graph.js';
import { MapView } from './mapview.js';

const $ = (sel) => document.querySelector(sel);

// One missing element used to throw and take the whole module down with it,
// leaving every button dead. Bind defensively and say what's missing instead.
const on = (sel, fn) => {
  const el = $(sel);
  if (el) el.onclick = fn;
  else console.warn('[interchange] no element for', sel);
};
const view = new MapView($('#map'));

let city = null;
let slots = { from: null, to: null };
let picking = null;

/* ---------------- boot ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}
navigator.storage?.persist?.();

updateNetState();
addEventListener('online', updateNetState);
addEventListener('offline', updateNetState);
addEventListener('resize', () => city && view.fit());

(async function start() {
  const lastId = await store.getPref('lastCity');
  const cities = await store.allCities();
  const pick = cities.find((c) => c.id === lastId) || cities[0];
  if (pick) loadCity(pick);
})();

function updateNetState() {
  const el = $('#net-state');
  const on = navigator.onLine;
  el.dataset.state = on ? 'online' : 'offline';
  el.textContent = on ? 'connected' : 'offline · cached';
}

/* ---------------- background builder ---------------- */

// Building a city is the one genuinely expensive thing this app does: Moscow is
// about 9.5 s of unbroken main-thread work, of which 1.4 s is a single
// JSON.parse that no amount of yielding can break up. A module worker moves the
// whole chain off the UI thread. Module workers need no bundler, which is the
// only reason this is possible here at all.
//
// `null` means the worker is unavailable and the caller should do the work
// inline, exactly as the app did before. An `error` is a real failure and must
// be shown to the user rather than silently retried.
let workerUnavailable = false;

function runInWorker(job, onStep, onProgress) {
  if (workerUnavailable || typeof Worker === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker('builder.worker.js', { type: 'module' });
    } catch {
      workerUnavailable = true;
      return resolve(null);
    }

    let ready = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshake);
      worker.terminate();
      resolve(value);
    };

    // A browser that ignores `type: 'module'` fails on the first import rather
    // than throwing above, so trust the worker only once it has said hello.
    const handshake = setTimeout(() => {
      if (!ready) { workerUnavailable = true; finish(null); }
    }, 4000);

    worker.onerror = () => {
      if (!ready) workerUnavailable = true;
      finish(null);
    };

    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { ready = true; clearTimeout(handshake); worker.postMessage(job); }
      else if (m.type === 'step') onStep?.(m.name, m.state);
      else if (m.type === 'progress') onProgress?.(m.text);
      else if (m.type === 'done') finish(m);
      else if (m.type === 'error') finish({ error: m.message });
    };
  });
}

/* ---------------- city ---------------- */

async function loadCity(c) {
  // Cities saved before the geometry was compacted are converted on first open
  // rather than on a sweep at boot: no network, and you only pay for the cities
  // you actually use. The map cannot be drawn until it finishes, because the
  // renderer reads packed geometry — so this is awaited, not fired and
  // forgotten. A record that fails to convert is left exactly as it was.
  if (needsMigration(c)) {
    $('#city-name').textContent = `Compacting ${c.name}…`;
    try {
      const off = await runInWorker({ type: 'migrate', id: c.id });
      if (off && !off.error) c = (await store.getCity(c.id)) || c;
      else if (migrateCity(c)) await store.saveCity(c);
    } catch (err) {
      console.warn('[interchange] could not compact', c.id, err);
    }
  }

  city = c;
  slots = { from: null, to: null };
  $('#city-name').textContent = c.name;
  $('#empty').hidden = true;
  $('#dock').hidden = false;
  $('#zoomhint').hidden = false;
  setTimeout(() => ($('#zoomhint').hidden = true), 4000);
  view.render(c);
  renderSlots();
  $('#trip').replaceChildren();
  store.setPref('lastCity', c.id);
}

view.onStationTap = (id) => {
  const s = city.stations.find((x) => x.id === id);
  if (!s) return;
  $('#st-name').textContent = s.name;
  $('#st-lines').textContent = s.lines.length
    ? s.lines.map((l) => l.label).join(' · ')
    : 'no line data';
  $('#dlg-station').dataset.station = id;
  $('#dlg-station').showModal();
};

on('#search-close', () => $('#dlg-search').close());
on('#add-close', () => $('#dlg-add').close());
for (const id of ['#search-input', '#place-input']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
}

on('#st-close', () => $('#dlg-station').close());
on('#st-from', () => assignFromSheet('from'));
on('#st-to', () => assignFromSheet('to'));

function assignFromSheet(slot) {
  const id = $('#dlg-station').dataset.station;
  slots[slot] = city.stations.find((s) => s.id === id) || null;
  $('#dlg-station').close();
  renderSlots();
  plan();
}

/* ---------------- trip planning ---------------- */

function renderSlots() {
  $('#slot-from').textContent = slots.from?.name || 'Choose start';
  $('#slot-to').textContent = slots.to?.name || 'Choose destination';
}

on('#slot-from', () => openSearch('from'));
on('#slot-to', () => openSearch('to'));
document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.onclick = () => {
    slots[btn.dataset.clear] = null;
    renderSlots();
    $('#trip').replaceChildren();
    view.showRoute(null);
  };
});

function openSearch(slot) {
  if (!city) return;
  picking = slot;
  $('#search-input').value = '';
  renderSearch('');
  $('#dlg-search').showModal();
  setTimeout(() => $('#search-input').focus(), 50);
}

$('#search-input').addEventListener('input', (e) => renderSearch(e.target.value));

function renderSearch(q) {
  const term = q.trim().toLowerCase();
  const rows = city.stations
    .filter((s) => !term || s.name.toLowerCase().includes(term))
    .sort((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name))
    .slice(0, 60);
  const ul = $('#search-results');
  ul.replaceChildren();
  if (!rows.length) {
    ul.innerHTML = '<li><p class="note" style="padding:14px">No station here matches that. Try a shorter spelling.</p></li>';
    return;
  }
  for (const s of rows) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'row';
    b.innerHTML = `<span class="row-main"><span>${esc(s.name)}</span><span class="row-sub">${
      s.lines.map((l) => esc(l.label)).join(' · ') || '—'
    }</span></span>`;
    b.onclick = () => {
      slots[picking] = s;
      $('#dlg-search').close();
      renderSlots();
      plan();
    };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function plan() {
  const out = $('#trip');
  out.replaceChildren();
  if (!slots.from || !slots.to) return;

  const result = findRoute(city, slots.from.id, slots.to.id);
  view.showRoute(result);
  if (!result) {
    out.innerHTML =
      '<p class="trip-fail">No connected path between these two in the cached network. They may be on separate systems, or a link is missing from OpenStreetMap here.</p>';
    return;
  }

  const head = document.createElement('div');
  head.className = 'trip-head';
  head.innerHTML = `<strong>${mins(result.seconds)}</strong><span>${
    result.changes === 0 ? 'direct' : result.changes + (result.changes === 1 ? ' change' : ' changes')
  }</span><span>estimated</span>`;
  out.appendChild(head);

  for (const leg of result.legs) {
    const el = document.createElement('div');
    el.className = 'leg' + (leg.walk ? ' walk' : '');
    el.style.setProperty('--leg-colour', leg.colour || '#8b939e');
    const hops = leg.stations.length - 1;
    el.innerHTML = `
      <div class="spine"><span class="node start"></span><span class="node end"></span></div>
      <div class="leg-body">
        <div class="leg-station">${esc(leg.stations[0].name)}</div>
        ${
          leg.walk
            ? `<div class="leg-note">Walk about ${leg.metres} m · ${mins(leg.seconds)}</div>`
            : `<div class="leg-line"><span class="bullet">${esc(leg.ref || '·')}</span>${esc(
                leg.mode || 'rail'
              )}</div>
               <div class="leg-stops">${hops} stop${hops === 1 ? '' : 's'} · ${mins(leg.seconds)}</div>`
        }
        <div class="leg-station terminal">${esc(leg.stations[leg.stations.length - 1].name)}</div>
      </div>`;
    out.appendChild(el);
  }
}

const mins = (s) => (s < 60 ? '<1 min' : Math.round(s / 60) + ' min');
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/* ---------------- locate ---------------- */

on('#btn-locate', () => {
  if (!city) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      view.showMe(latitude, longitude);
      const hit = nearest(city, latitude, longitude);
      if (!hit) return;
      view.centreOn(latitude, longitude, Math.max(view.k, 0.004));
      slots.from = hit.s;
      renderSlots();
      plan();
    },
    () => alert('Location is off for this site. GPS still works offline once you allow it.'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

/* ---------------- cities sheet ---------------- */

on('#btn-cities', openCities);
on('#cities-close', () => $('#dlg-cities').close());
on('#btn-add-first', openAdd);
on('#btn-add-city', () => { $('#dlg-cities').close(); openAdd(); });

async function openCities() {
  const cities = await store.allCities();
  const ul = $('#city-list');
  ul.replaceChildren();
  for (const c of cities) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'row';
    b.innerHTML = `<span class="row-main"><span>${esc(c.name)}</span><span class="row-sub">${
      c.stats.stations
    } stations · ${c.stats.lines} lines · saved ${when(c.savedAt)}</span></span>`;
    b.onclick = () => { $('#dlg-cities').close(); loadCity(c); };
    const del = document.createElement('button');
    del.className = 'row-del';
    del.textContent = 'Remove';
    del.onclick = async (e) => {
      e.stopPropagation();
      await store.deleteCity(c.id);
      if (city?.id === c.id) location.reload();
      openCities();
    };
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.append(b, del);
    li.appendChild(wrap);
    ul.appendChild(li);
  }
  if (!cities.length) {
    ul.innerHTML = '<li><p class="note" style="padding:14px">Nothing saved yet.</p></li>';
  }
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $('#storage-note').innerHTML = est
    ? `Using <strong>${(est.usage / 1e6).toFixed(1)} MB</strong> of about ${(est.quota / 1e6).toFixed(
        0
      )} MB available. Storage is ${persisted ? 'marked persistent' : 'not yet persistent — install the app to your home screen to protect it'}.`
    : '';
  $('#dlg-cities').showModal();
}

const when = (ts) => {
  const days = Math.floor((Date.now() - ts) / 864e5);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
};

/* ---------------- add a city ---------------- */

function openAdd() {
  $('#place-input').value = '';
  $('#place-results').replaceChildren();
  $('#fetch-status').hidden = true;
  $('#mode-picker').hidden = false;
  $('#dlg-add').showModal();
  setTimeout(() => $('#place-input').focus(), 50);
}

let searchTimer;
$('#place-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) return;
  searchTimer = setTimeout(() => runGeocode(q), 400);
});

async function runGeocode(q) {
  const ul = $('#place-results');
  ul.innerHTML = '<li><p class="note" style="padding:14px">Searching…</p></li>';
  try {
    const places = await geocode(q);
    ul.replaceChildren();
    if (!places.length) {
      ul.innerHTML = '<li><p class="note" style="padding:14px">No place by that name.</p></li>';
      return;
    }
    for (const p of places) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'row';
      b.innerHTML = `<span class="row-main"><span>${esc(p.short)}</span><span class="row-sub">${esc(
        p.name.split(',').slice(1, 3).join(',').trim()
      )}</span></span>`;
      b.onclick = () => download(p);
      li.appendChild(b);
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = `<li><p class="note" style="padding:14px">${esc(err.message)}</p></li>`;
  }
}

function step(name, state) {
  const el = document.querySelector(`.tick[data-step="${name}"]`)?.parentElement;
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
}

async function download(place) {
  const modes = [...document.querySelectorAll('#mode-picker input:checked')].map((i) => i.value);
  if (!modes.length) return alert('Pick at least one kind of line.');

  $('#place-results').replaceChildren();
  $('#mode-picker').hidden = true;
  $('#fetch-status').hidden = false;
  ['geo', 'query', 'build', 'save'].forEach((s) => step(s, null));
  const msg = $('#fetch-msg');

  const job = {
    id: `${place.short}-${place.lat.toFixed(2)}-${place.lon.toFixed(2)}`,
    name: place.short,
    bbox: place.bbox,
    modes,
  };

  try {
    step('geo', 'done');
    msg.textContent = 'Large networks can take a minute. Keep this open.';

    // Off the main thread where the browser allows it, so the progress ticks
    // keep animating instead of freezing mid-download.
    const off = await runInWorker(job, step, (t) => (msg.textContent = t));
    if (off?.error) throw new Error(off.error);

    let built;
    if (off) {
      built = await store.getCity(job.id);
    } else {
      step('query', 'active');
      const raw = await fetchNetwork(job.bbox, modes, (t) => (msg.textContent = t));

      step('query', 'done');
      step('build', 'active');
      msg.textContent = `${raw.elements.length.toLocaleString()} map objects received.`;
      await new Promise((r) => setTimeout(r, 30));
      built = buildCity(raw, job);

      if (!built.stations.length) throw new Error(emptyNetworkMessage(raw));

      step('build', 'done');
      step('save', 'active');
      await store.saveCity(built);
      step('save', 'done');
    }
    msg.innerHTML = `Saved <strong>${built.stats.stations} stations</strong> across ${built.stats.lines} lines. This works offline now.`;
    setTimeout(() => {
      $('#dlg-add').close();
      loadCity(built);
    }, 900);
  } catch (err) {
    ['geo', 'query', 'build', 'save'].forEach((s) => {
      const el = document.querySelector(`.tick[data-step="${s}"]`)?.parentElement;
      if (el?.classList.contains('active')) el.classList.remove('active');
    });
    msg.innerHTML = `${esc(err.message)}`;
    $('#mode-picker').hidden = false;
  }
}
