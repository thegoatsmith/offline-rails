// data.ts — where a city comes from and where it lives afterwards.
//
// Online, once: Nominatim gives us a bounding box, Overpass gives us every
// route relation inside it. We fold that into stations + lines + a routing
// graph and put the whole thing in IndexedDB. After that the network is a
// local object and nothing here runs again.

import type {
  BBox,
  City,
  Edge,
  Graph,
  Line,
  MaybeBBox,
  OverpassElement,
  OverpassMember,
  OverpassResponse,
  PackedShape,
  Place,
  Station,
  StationLine,
} from './types.ts';

// overpass.osm.ch used to be third here and was removed: it answers 200 with an
// empty element list for queries the others serve fully — verified against
// Lisbon, Moscow and Prague, the last returning 0 elements where overpass-api.de
// returned 598. A mirror that fails is fine, the fallback handles it. A mirror
// that lies is worse than no mirror, because being last it was the answer we
// believed.
// Thrown when a mirror answers 200 with no elements, and compared by message
// in the catch below — one constant so the two sites cannot drift apart.
const EMPTY = 'sent nothing back';

export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  // Last on purpose. It is VK's instance, and this app exists to avoid sending
  // anything to a company that would rather have the data, so it is reached
  // only when both of the others have already failed. It earns the slot by
  // being the only global instance left that needs no API key: of the seven the
  // wiki lists, four require a key or payment, one is overpass-api.de itself,
  // and private.coffee — which overpass.kumi.systems now resolves to, the same
  // 193.219.97.30 — was timing out when this was written, as kumi itself was
  // answering 502. Checked against fd5112c's three reference cities before
  // being added: Lisbon 8, Prague 6 and Moscow 32 subway relations, matching
  // overpass-api.de exactly, with CORS and a data timestamp a minute apart.
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const DB_NAME = 'offline-rails';
const DB_VERSION = 1;

/* ---------------- IndexedDB ---------------- */

// One connection for the life of the page, not one per transaction. Opening a
// fresh connection per call leaks them — nothing ever closes them — and a leaked
// connection blocks `deleteDatabase` and any future version change forever,
// which wedges IndexedDB for the whole origin: every later open() then hangs
// without firing success, error or blocked. `onversionchange` closes the handle
// so another tab deleting the database is not held hostage by this one.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cities'))
        db.createObjectStore('cities', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function tx<T>(
  storeName: 'cities' | 'prefs',
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest | undefined,
): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve((req?.result ?? undefined) as T);
    t.onerror = () => reject(t.error);
  });
}

export const store = {
  saveCity: (city: City) => tx<void>('cities', 'readwrite', (s) => s.put(city)),
  getCity: (id: string) => tx<City | undefined>('cities', 'readonly', (s) => s.get(id)),
  allCities: () => tx<City[]>('cities', 'readonly', (s) => s.getAll()),
  deleteCity: (id: string) => tx<void>('cities', 'readwrite', (s) => s.delete(id)),
  setPref: (k: string, v: unknown) => tx<void>('prefs', 'readwrite', (s) => s.put(v, k)),
  getPref: <T>(k: string) => tx<T | undefined>('prefs', 'readonly', (s) => s.get(k)),
};

/* ---------------- geometry helpers ---------------- */

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

interface Point {
  lat: number;
  lon: number;
}

export function haversine(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ---------------- geocoding ---------------- */

interface NominatimRow {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
  osm_type?: string;
  osm_id?: number;
  place_id?: number;
}

/**
 * Nominatim happily returns two rows with the same `display_name` — searching
 * Moscow gives the city and the federal subject, both labelled "Москва,
 * Центральный федеральный округ, Россия", as relations 102269 and 2555133.
 * Keying a list on the name therefore crashes Svelte with `each_key_duplicate`.
 * The OSM type and id are the real identity; place_id and finally the
 * coordinates are fallbacks for rows that carry neither.
 */
export function placeId(row: {
  osm_type?: string;
  osm_id?: number;
  place_id?: number;
  lat: string;
  lon: string;
}): string {
  if (row.osm_type && row.osm_id != null) return `${row.osm_type}/${row.osm_id}`;
  if (row.place_id != null) return `place/${row.place_id}`;
  return `at/${row.lat},${row.lon}`;
}

export async function geocode(query: string): Promise<Place[]> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Place search is unavailable right now.');
  const rows = (await res.json()) as NominatimRow[];
  return rows.map((r) => ({
    id: placeId(r),
    name: r.display_name,
    spanKm: rawSpanKm(r.boundingbox.map(Number) as [number, number, number, number], +r.lat),
    short: r.name || r.display_name.split(',')[0]!,
    lat: +r.lat,
    lon: +r.lon,
    bbox: clampBox(r.boundingbox.map(Number) as [number, number, number, number], +r.lat, +r.lon),
  }));
}

// The un-clamped width, used only to tell two identically-named results apart.
function rawSpanKm(
  [south, north, west, east]: [number, number, number, number],
  lat: number,
): number {
  const wide = (east - west) * 111.32 * Math.cos(rad(lat));
  const tall = (north - south) * 110.574;
  return Math.round(Math.max(Math.abs(wide), Math.abs(tall)));
}

// Nominatim boxes swing from a single point to an entire prefecture.
// Clamp to something a metro network actually fits in: 12–55 km half-width.
function clampBox(
  [south, north, west, east]: [number, number, number, number],
  lat: number,
  lon: number,
): BBox {
  const kmLat = 1 / 110.574;
  const kmLon = 1 / (111.32 * Math.cos(rad(lat)) || 1);
  const halfLat = Math.min(Math.max((north - south) / 2, 12 * kmLat), 55 * kmLat);
  const halfLon = Math.min(Math.max((east - west) / 2, 12 * kmLon), 55 * kmLon);
  return {
    south: lat - halfLat,
    north: lat + halfLat,
    west: lon - halfLon,
    east: lon + halfLon,
  };
}

/* ---------------- Overpass ---------------- */

function buildQuery(bbox: BBox, modes: string[]): string {
  const box = `${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)}`;
  const filter = modes.join('|');
  // Asking for the relations with `out geom` returns every member way in full,
  // however far past the city it runs. Moscow with suburban rail came to 223 MB,
  // of which 89% was geometry outside the box that was asked for and thrown
  // away on arrival. Fetching ways and nodes separately and bounding both to the
  // box is the same map for 40 MB, downloads in 7.6 s instead of 41, and builds
  // in 0.37 s instead of 6.85. buildCity joins the ways back to their relation
  // by ref.
  //
  // Note this makes small cities marginally larger — Lisbon grows about 11%,
  // because every way now arrives as its own element with its own id instead of
  // inline. That is a good trade: it costs a rounding error on a network that
  // fits in the box and saves 183 MB on one that does not.
  return `[out:json][timeout:240];
rel["type"="route"]["route"~"^(${filter})$"](${box})->.r;
.r out body;
way(r.r)(${box})->.w;
.w out geom;
node(r.r)(${box})->.n;
.n out body;`;
}

export async function fetchNetwork(
  bbox: BBox,
  modes: string[],
  onProgress?: (text: string) => void,
): Promise<OverpassResponse> {
  const body = 'data=' + encodeURIComponent(buildQuery(bbox, modes));
  const controllers = OVERPASS.map(() => new AbortController());
  // Indexed by mirror rather than appended to, so the message reads in list
  // order however the failures happen to arrive.
  const failures: (string | undefined)[] = [];
  let sawEmpty = false;
  let sawFailure = false;

  onProgress?.(`Asking ${OVERPASS.length} mirrors…`);

  const attempts = OVERPASS.map(async (endpoint, i) => {
    const host = new URL(endpoint).hostname;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controllers[i]!.signal,
      });
      if (res.status === 429 || res.status === 504) throw new Error('was busy');
      if (!res.ok) throw new Error('returned ' + res.status);
      const json = (await res.json()) as OverpassResponse;
      if (!json.elements?.length) throw new Error(EMPTY);
      return json;
    } catch (err) {
      // A loser is aborted the moment another mirror wins. That is a
      // cancellation we caused, not a mirror that failed, and recording it
      // would put "could not be reached" against a server that was fine.
      if ((err as Error).name === 'AbortError') throw err;
      const message = (err as Error).message;
      if (message === EMPTY) sawEmpty = true;
      else sawFailure = true;
      // A request that never got a response rejects with a TypeError whose
      // message is the browser's, not ours — "Failed to fetch" in Chrome,
      // "Load failed" in Safari, and neither says which host it means. A
      // refused connection and a blocked one are indistinguishable here too,
      // so claim only what is certain: nothing came back from this host.
      const reason = err instanceof TypeError ? 'could not be reached' : message;
      failures[i] = `${host} ${reason}`;
      onProgress?.(`${host} ${reason}`);
      throw err;
    }
  });

  try {
    // Promise.any, not race: race settles on the first promise to *settle*, so
    // a mirror that 502s in 200ms would decide the whole add while a working
    // one was still in flight. any waits for a fulfilment.
    const winner = await Promise.any(attempts);
    // The winner's body has already been read, so aborting its controller with
    // the rest is a no-op — cheaper than tracking which one won.
    for (const c of controllers) c.abort();
    return winner;
  } catch {
    // An empty answer is only the truth when every mirror answered and they all
    // agreed. If any of them failed outright, the honest report is that the
    // servers are struggling — saying "nothing is mapped here" would blame the
    // map for an outage, which is exactly what happened when a mirror that
    // returns 200-with-nothing sat last in the list.
    if (sawEmpty && !sawFailure) return { elements: [] };

    throw new Error(
      `Every OpenStreetMap mirror failed. ${failures
        .filter((f): f is string => Boolean(f))
        .join('; ')}. Try again in a minute.`,
    );
  }
}

/* ---------------- building the network ---------------- */

// A city with no metro and a mirror having a bad day both answer 200 with an
// empty element list, and nothing in the response tells them apart. Observed in
// practice: overpass.osm.ch returned zero elements for Lisbon while
// overpass-api.de returned 554 for the identical query. So when nothing at all
// came back, say both things might be true rather than asserting the map is
// empty; when elements did arrive but no stops could be read from them, the
// mode choice really is the likely culprit.
export function emptyNetworkMessage(raw: OverpassResponse): string {
  return raw.elements?.length
    ? 'No rail lines are mapped here for the modes you picked. Try adding tram or suburban rail.'
    : 'OpenStreetMap sent back nothing for this area. Either nothing is mapped here for the modes you picked, or its servers are busy — try again in a minute.';
}

const norm = (s: string | undefined): string =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(
      /\b(station|stn|metro|subway|underground|bahnhof|gare|estacion|estación|stazione|станция|駅|站|역)\b/g,
      '',
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const SPEED: Record<string, number> = {
  subway: 11,
  light_rail: 9,
  tram: 6.5,
  monorail: 10,
  train: 16,
};
const DWELL = 25;
const WALK_SPEED = 1.2;
const TRANSFER_PENALTY = 240;
const LINK_RADIUS = 350;
const SIMPLIFY_TOLERANCE = 10; // metres — below the width of the platform you're on
const COORD_SCALE = 1e6; // ~0.11 m per unit, comfortably inside Int32
const CITY_FORMAT = 2; // bump when the stored record shape changes

type LatLon = [number, number];

// Douglas-Peucker, iterative. A chained London polyline runs to tens of
// thousands of points and recursion overflows the stack long before that.
// Distance is in metres via the same equirectangular approximation the walking
// links use, with cos(lat) taken once per polyline rather than per point.
function perpendicular(p: LatLon, a: LatLon, b: LatLon, cosLat: number): number {
  const px = (p[1] - a[1]) * cosLat * 111320,
    py = (p[0] - a[0]) * 110574;
  const bx = (b[1] - a[1]) * cosLat * 111320,
    by = (b[0] - a[0]) * 110574;
  const len = bx * bx + by * by;
  if (!len) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - t * bx, py - t * by);
}

export function simplify(points: LatLon[], tolerance: number): LatLon[] {
  if (points.length < 3) return points;
  const cosLat = Math.cos((points[0]![0] * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1,
      at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = perpendicular(points[k]!, points[i]!, points[j]!, cosLat);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  const out: LatLon[] = [];
  for (let k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]!);
  return out;
}

// Stored geometry is render-only — nothing routes off it — so it does not need
// double precision. One Int32Array of round(degrees * 1e6) is 8 bytes a point
// against roughly 24 for an array of [lat, lon] pairs, and structured-clones as
// raw bytes instead of a million tiny arrays.
function encodeShape(points: LatLon[]): PackedShape {
  const out = new Int32Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[i * 2] = Math.round(points[i]![0] * COORD_SCALE);
    out[i * 2 + 1] = Math.round(points[i]![1] * COORD_SCALE);
  }
  return out;
}

export function decodeShape(encoded: PackedShape): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i < encoded.length; i += 2) {
    out.push([encoded[i]! / COORD_SCALE, encoded[i + 1]! / COORD_SCALE]);
  }
  return out;
}

const compactShape = (points: LatLon[]): PackedShape =>
  encodeShape(simplify(points, SIMPLIFY_TOLERANCE));

// The renderer reads shapes as flat Int32Arrays, so an unconverted record
// cannot be drawn at all — the page has to know before it renders, not after.
export const needsMigration = (city: City): boolean => !(city.format >= CITY_FORMAT);

// Records written before the geometry was compacted carry no format marker.
// Migrating costs one pass and no network, which matters because the whole
// point of this app is working with no signal.
export function migrateCity(city: City): boolean {
  if (city.format >= CITY_FORMAT) return false;
  for (const line of city.lines) {
    line.shapes = (line.shapes as unknown as LatLon[][]).map(compactShape);
  }
  city.format = CITY_FORMAT;
  return true;
}

// Overpass selects a relation if *any* member falls in the bounding box, then
// `out geom` returns that relation in full. Ask for Moscow with suburban rail
// and you get whole Russian Railways services: 59% of the stations and 89% of
// the geometry sat outside the box the user actually asked for, including a
// route from Khabarovsk 6,500 km away. Clipping is not only a size fix — a
// Moscow metro map with Khabarovsk on it is simply wrong.
function boxTest(bbox: MaybeBBox | undefined): ((lat: number, lon: number) => boolean) | null {
  if (!bbox || bbox.south == null || bbox.north == null) return null;
  const { south, north, west, east } = bbox as BBox;
  return (lat, lon) => lat >= south && lat <= north && lon >= west && lon <= east;
}

// Keeps one point past each crossing so a line still runs to the edge of the
// map rather than stopping short of it, and splits where a route leaves and
// re-enters instead of drawing a chord across the gap.
function clipShapes(
  shapes: LatLon[][],
  within: ((lat: number, lon: number) => boolean) | null,
): LatLon[][] {
  if (!within) return shapes;
  const out: LatLon[][] = [];
  for (const shape of shapes) {
    let run: LatLon[] | null = null;
    for (let i = 0; i < shape.length; i++) {
      const p = shape[i]!;
      if (within(p[0], p[1])) {
        if (!run) {
          run = [];
          if (i > 0) run.push(shape[i - 1]!);
        }
        run.push(p);
      } else if (run) {
        run.push(p);
        if (run.length > 1) out.push(run);
        run = null;
      }
    }
    if (run && run.length > 1) out.push(run);
  }
  return out;
}

// OSM lists a route relation's ways in travel order, but each way keeps its
// own digitisation direction, so consecutive ways meet end-to-start only about
// 80% of the time and otherwise join end-to-end or start-to-start. Drawn
// unmerged that is one <path> per way — 374k elements on a network the size of
// Moscow, which is the difference between a map that pans and one that does
// not. Chaining on the shared endpoint collapses it to roughly one per route.
function chainShapes(shapes: LatLon[][]): LatLon[][] {
  const usable = shapes.filter((s) => s.length > 1);
  if (usable.length < 2) return usable;

  const key = (p: LatLon) => p[0].toFixed(6) + ',' + p[1].toFixed(6);
  const ends = new Map<string, number[]>();
  const index = (k: string, i: number) => {
    const at = ends.get(k);
    if (at) at.push(i);
    else ends.set(k, [i]);
  };
  usable.forEach((s, i) => {
    index(key(s[0]!), i);
    index(key(s[s.length - 1]!), i);
  });

  const used: boolean[] = Array.from({ length: usable.length }, () => false);
  const take = (k: string) => {
    for (const i of ends.get(k) || []) if (!used[i]) return i;
    return -1;
  };

  const out: LatLon[][] = [];
  for (let i = 0; i < usable.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = usable[i]!;

    for (;;) {
      const k = key(chain[chain.length - 1]!);
      const j = take(k);
      if (j < 0) break;
      used[j] = true;
      const s = usable[j]!;
      chain = chain.concat(key(s[0]!) === k ? s.slice(1) : s.slice(0, -1).toReversed());
    }
    for (;;) {
      const k = key(chain[0]!);
      const j = take(k);
      if (j < 0) break;
      used[j] = true;
      const s = usable[j]!;
      chain = (key(s[s.length - 1]!) === k ? s.slice(0, -1) : s.slice(1).toReversed()).concat(
        chain,
      );
    }
    out.push(chain);
  }
  return out;
}

export function buildCity(
  raw: OverpassResponse,
  meta: { id: string; name: string; bbox: MaybeBBox; modes: string[] },
): City {
  const within = boxTest(meta.bbox);
  const nodes = new Map<number, OverpassElement>();
  const ways = new Map<number, OverpassElement>();
  const rels: OverpassElement[] = [];
  for (const el of raw.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation') rels.push(el);
  }

  const stations: Station[] = [];
  const byKey = new Map<string, number[]>(); // normalised name -> station indices

  function stationFor(node: OverpassMember): Station | null {
    const tags = nodes.get(node.ref)?.tags || {};
    const lat = node.lat ?? nodes.get(node.ref)?.lat;
    const lon = node.lon ?? nodes.get(node.ref)?.lon;
    if (lat == null || lon == null) return null;
    if (within && !within(lat, lon)) return null;

    const rawName = tags.name || tags['name:en'] || tags.ref || '';
    const key = norm(rawName);
    const point = { lat, lon };

    // Same name within 900 m, or unnamed within 80 m, is one station.
    const candidates = byKey.get(key) || [];
    for (const idx of candidates) {
      const st = stations[idx]!;
      const limit = key ? 900 : 80;
      if (haversine(st, point) < limit) return st;
    }

    const st: Station = {
      id: 's' + stations.length,
      name: rawName || 'Unnamed stop',
      lat,
      lon,
      lines: [],
    };
    stations.push(st);
    candidates.push(stations.length - 1);
    byKey.set(key, candidates);
    return st;
  }

  const lines: Line[] = [];
  for (const rel of rels) {
    const t = rel.tags || {};
    const mode = t.route;
    const stops: Station[] = [];
    const shapes: LatLon[][] = [];

    for (const m of rel.members || []) {
      if (m.type === 'node' && (m.role || '').startsWith('stop')) {
        const st = stationFor(m);
        if (st && st !== stops[stops.length - 1]) stops.push(st);
      } else if (m.type === 'way' && !m.role) {
        // A member carries its own geometry when the query asked for the
        // relation with `out geom`, and none when the ways were fetched
        // separately so they could be bounded to the city. Accept both.
        const geometry = m.geometry || ways.get(m.ref)?.geometry;
        if (geometry) shapes.push(geometry.map((p) => [p.lat, p.lon] as LatLon));
      }
    }

    // Some cities only tag platforms, not stop positions.
    if (stops.length < 2) {
      for (const m of rel.members || []) {
        if (m.type === 'node' && /platform/.test(m.role || '')) {
          const st = stationFor(m);
          if (st && st !== stops[stops.length - 1]) stops.push(st);
        }
      }
    }
    if (stops.length < 2 && !shapes.length) continue;

    const line: Line = {
      id: 'l' + lines.length,
      ref: t.ref || t.name?.split(':')[0]?.trim() || '?',
      name: t.name || t.ref || 'Unnamed route',
      colour: normaliseColour(t.colour || t.color),
      mode,
      stops: stops.map((s) => s.id),
      shapes: clipShapes(chainShapes(shapes), within).map(compactShape),
    };
    lines.push(line);

    const label = line.ref;
    for (const s of stops) {
      if (!s.lines.some((l: StationLine) => l.label === label && l.colour === line.colour)) {
        s.lines.push({ label, colour: line.colour, name: line.name, mode });
      }
    }
  }

  const byId = new Map(stations.map((s) => [s.id, s]));
  const graph = buildGraph(stations, lines, byId);

  return {
    id: meta.id,
    format: CITY_FORMAT,
    name: meta.name,
    bbox: meta.bbox,
    modes: meta.modes,
    savedAt: Date.now(),
    stations,
    lines,
    graph,
    stats: {
      stations: stations.length,
      routes: lines.length,
      lines: new Set(lines.map((l) => l.ref + l.colour)).size,
    },
  };
}

function normaliseColour(c: string | undefined): string | null {
  if (!c) return null;
  const v = c.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  const named: Record<string, string> = {
    red: '#d64545',
    blue: '#3a72c4',
    green: '#3f9a5c',
    yellow: '#e0b530',
    orange: '#e08a30',
    purple: '#8a5bc4',
    brown: '#8a6a4a',
    grey: '#8b939e',
    gray: '#8b939e',
    black: '#41474f',
    white: '#c9ced6',
    pink: '#d96fa8',
    silver: '#a8adb5',
    gold: '#d4af37',
    cyan: '#3fb0c4',
    magenta: '#c44a9a',
  };
  return named[v.toLowerCase()] || null;
}

// Adjacency: ride edges from consecutive stops, walk edges between anything
// close enough to interchange on foot.
function buildGraph(stations: Station[], lines: Line[], byId: Map<string, Station>): Graph {
  const adj: Record<string, Edge[]> = {};
  for (const s of stations) adj[s.id] = [];

  for (const line of lines) {
    const speed = SPEED[line.mode ?? ''] || 10;
    for (let i = 0; i < line.stops.length - 1; i++) {
      const a = byId.get(line.stops[i]!);
      const b = byId.get(line.stops[i + 1]!);
      if (!a || !b) continue;
      const cost = haversine(a, b) / speed + DWELL;
      adj[a.id]!.push({
        to: b.id,
        cost,
        line: line.id,
        ref: line.ref,
        colour: line.colour,
        mode: line.mode,
      });
      adj[b.id]!.push({
        to: a.id,
        cost,
        line: line.id,
        ref: line.ref,
        colour: line.colour,
        mode: line.mode,
      });
    }
  }

  // Spatial hash so this stays fast on a 500-station network.
  const cell = 0.004;
  const grid = new Map<string, Station[]>();
  for (const s of stations) {
    const k = `${Math.floor(s.lat / cell)},${Math.floor(s.lon / cell)}`;
    const at = grid.get(k);
    if (at) at.push(s);
    else grid.set(k, [s]);
  }
  const links: [string, string][] = [];
  for (const s of stations) {
    const gx = Math.floor(s.lat / cell);
    const gy = Math.floor(s.lon / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const o of grid.get(`${gx + dx},${gy + dy}`) || []) {
          if (o.id <= s.id) continue;
          const d = haversine(s, o);
          if (d > LINK_RADIUS) continue;
          const cost = d / WALK_SPEED + 45;
          adj[s.id]!.push({ to: o.id, cost, line: 'walk', walk: true, metres: Math.round(d) });
          adj[o.id]!.push({ to: s.id, cost, line: 'walk', walk: true, metres: Math.round(d) });
          links.push([s.id, o.id]);
        }
      }
    }
  }
  return { adj, links, transferPenalty: TRANSFER_PENALTY };
}
