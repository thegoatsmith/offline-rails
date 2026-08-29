// tests/network.test.mjs — run with: node tests/network.test.mjs
//
// These exercise the parts that have no browser in them: station merging,
// graph construction and routing. Synthetic Overpass payloads, no network.

import { buildCity, simplify, decodeShape, migrateCity } from '../data.js';
import { route, nearest } from '../graph.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`));
  if (!ok) failures++;
}

const node = (id, name, lat, lon) => ({ type: 'node', id, lat, lon, tags: { name, railway: 'stop' } });
const stopMember = (nodes) => (id) => {
  const n = nodes.find((x) => x.id === id);
  return { type: 'node', ref: id, role: 'stop', lat: n.lat, lon: n.lon };
};
const relation = (nodes) => (id, ref, colour, ids) => ({
  type: 'relation',
  id,
  tags: { type: 'route', route: 'subway', ref, name: `${ref} line`, colour },
  members: ids.map(stopMember(nodes)),
});

/* --- 1. two lines meeting at a shared name, one change --- */
{
  const nodes = [
    node(1, 'Westgate', 51.500, -0.140),
    node(2, 'Central', 51.505, -0.130),
    node(3, 'Eastcote', 51.510, -0.120),
    node(4, 'Northfield', 51.515, -0.132),
    node(5, 'Central', 51.5051, -0.1301), // same name, different platform node
    node(6, 'Southbank', 51.498, -0.128),
  ];
  const rel = relation(nodes);
  const city = buildCity(
    { elements: [...nodes, rel(1, 'A', '#d64545', [1, 2, 3]), rel(2, 'B', '#3a72c4', [4, 5, 6])] },
    { id: 't1', name: 'Testville', bbox: {}, modes: ['subway'] }
  );

  check('duplicate platform nodes merge into one station', city.stats.stations, 5);
  check('shared station carries both lines',
    city.stations.find((s) => s.name === 'Central').lines.map((l) => l.label), ['A', 'B']);

  const r = route(city, 's0', 's4'); // Westgate -> Southbank
  check('cross-network trip needs one change', r.changes, 1);
  check('legs are collapsed per line', r.legs.map((l) => l.ref), ['A', 'B']);

  const direct = route(city, 's0', 's2');
  check('same-line trip has no changes', direct.changes, 0);
  check('nearest station lookup', nearest(city, 51.5045, -0.1315).s.name, 'Central');
}

/* --- 2. out-of-station interchange via a walking link --- */
{
  const nodes = [
    node(1, 'Westgate', 51.500, -0.140),
    node(2, 'Central', 51.505, -0.130),
    node(7, 'Riverside', 51.5052, -0.1277), // ~160 m from Central, different name
    node(8, 'Docks', 51.507, -0.121),
  ];
  const rel = relation(nodes);
  const city = buildCity(
    { elements: [...nodes, rel(1, 'A', '#3f9a5c', [1, 2]), rel(2, 'C', '#e0b530', [7, 8])] },
    { id: 't2', name: 'Linkville', bbox: {}, modes: ['subway'] }
  );

  check('nearby distinct stations get one walking link', city.graph.links.length, 1);
  const r = route(city, 's0', 's3');
  check('route walks between the two systems', r.legs.map((l) => (l.walk ? 'walk' : l.ref)), ['A', 'walk', 'C']);
  check('walk leg reports a distance', typeof r.legs[1].metres, 'number');
}

/* --- 3. platform-only tagging fallback --- */
{
  const nodes = [
    { type: 'node', id: 1, lat: 48.85, lon: 2.35, tags: { name: 'Alpha', railway: 'platform' } },
    { type: 'node', id: 2, lat: 48.86, lon: 2.36, tags: { name: 'Beta', railway: 'platform' } },
  ];
  const city = buildCity(
    {
      elements: [
        ...nodes,
        {
          type: 'relation', id: 9,
          tags: { type: 'route', route: 'tram', ref: 'T1', name: 'T1' },
          members: nodes.map((n) => ({ type: 'node', ref: n.id, role: 'platform', lat: n.lat, lon: n.lon })),
        },
      ],
    },
    { id: 't3', name: 'Platformville', bbox: {}, modes: ['tram'] }
  );
  check('falls back to platform roles when no stop roles exist', city.stats.stations, 2);
}

/* --- 4. way geometry is chained into continuous polylines --- */
{
  // OSM lists a relation's ways in travel order but each way keeps its own
  // digitisation direction, so consecutive ways often meet end-to-end or
  // start-to-start. Drawn unmerged that is one <path> per way — 374k of them
  // on a network the size of Moscow, which is why the map stopped panning.
  const way = (geometry) => ({ type: 'way', ref: 1, role: '', geometry });
  const P = (lat, lon) => ({ lat, lon });

  const city = buildCity(
    {
      elements: [
        {
          type: 'relation', id: 1,
          tags: { type: 'route', route: 'subway', ref: 'M', name: 'M line' },
          // deliberately a zigzag: collinear points would be removed again by the
          // simplifier downstream and the chaining assertion would prove nothing
          members: [
            way([P(0, 0), P(0.001, 0.001)]),        // forward
            way([P(0, 0.002), P(0.001, 0.001)]),    // reversed: meets previous end at ITS end
            way([P(0, 0.002), P(0.001, 0.003)]),    // forward again
            way([P(9, 9), P(9, 9.0005)]),           // genuinely disconnected
          ],
        },
      ],
    },
    { id: 't4', name: 'Chainville', bbox: {}, modes: ['subway'] }
  );

  // shapes come back encoded, so decode before comparing
  const shapes = city.lines[0].shapes.map(decodeShape);
  check('contiguous ways merge into one polyline', shapes.length, 2);
  check('merged polyline runs end to end',
    shapes.find((s) => s.length > 2), [[0, 0], [0.001, 0.001], [0, 0.002], [0.001, 0.003]]);
  check('a real gap stays a separate polyline',
    shapes.find((s) => s.length === 2), [[9, 9], [9, 9.0005]]);
  check('shapes are stored as typed arrays', city.lines[0].shapes[0] instanceof Int32Array, true);
}

/* --- 5. geometry is simplified and compacted --- */
{
  // A detour of a few metres is below what anyone can see at city zoom and is
  // most of the 5.4 million points Moscow used to store. A real corner is not.
  const straightish = [[0, 0], [0.0000045, 0.5], [0, 1]];   // ~0.5 m off the line
  const corner      = [[0, 0], [0.0009, 0.5], [0, 1]];      // ~100 m off the line

  check('a sub-tolerance wobble is dropped', simplify(straightish, 10).length, 2);
  check('a real corner survives', simplify(corner, 10).length, 3);
  check('endpoints always survive',
    [simplify(straightish, 10)[0], simplify(straightish, 10)[1]], [[0, 0], [0, 1]]);
  check('too short to simplify is returned as is', simplify([[1, 1], [2, 2]], 10).length, 2);

  // round(deg * 1e6) is ~0.11 m; assert the round trip stays inside that.
  const city = buildCity(
    {
      elements: [
        {
          type: 'relation', id: 1,
          tags: { type: 'route', route: 'subway', ref: 'M', name: 'M' },
          members: [{ type: 'way', ref: 1, role: '', geometry: [
            { lat: 51.5074123, lon: -0.1278456 }, { lat: 51.5, lon: -0.2 },
          ] }],
        },
      ],
    },
    { id: 't5', name: 'Roundtrip', bbox: {}, modes: ['subway'] }
  );
  const back = decodeShape(city.lines[0].shapes[0])[0];
  const offBy = Math.max(Math.abs(back[0] - 51.5074123), Math.abs(back[1] - -0.1278456));
  check('encoding round-trips within ~0.11 m', offBy < 1e-6, true);
  check('new records carry the format marker', city.format, 2);
}

/* --- 6. old records migrate without a network --- */
{
  const legacy = {
    id: 'old', name: 'Legacy', bbox: {}, modes: ['subway'], stations: [], graph: { adj: {}, links: [] },
    lines: [{ id: 'l0', ref: 'M', shapes: [[[0, 0], [0.0000045, 0.5], [0, 1]]] }],
  };
  check('a pre-format record reports as migrated', migrateCity(legacy), true);
  check('migration encodes the geometry', legacy.lines[0].shapes[0] instanceof Int32Array, true);
  check('migration simplifies too', legacy.lines[0].shapes[0].length / 2, 2);
  check('migration is idempotent', migrateCity(legacy), false);
}

/* --- 7. the network is clipped to the box that was asked for --- */
{
  // Overpass returns a whole relation if any one member is in the box, so a
  // long-distance service that merely calls at the city drags its entire route
  // in with it. Moscow arrived with 59% of its stations and 89% of its geometry
  // outside the requested box, one of them 6,500 km away in Khabarovsk.
  const bbox = { south: 0, north: 1, west: 0, east: 1 };
  const near = (id, name, lat, lon) => ({ type: 'node', id, lat, lon, tags: { name, railway: 'stop' } });
  const nodes = [
    near(1, 'Inside A', 0.2, 0.2),
    near(2, 'Inside B', 0.8, 0.8),
    near(3, 'Far Away', 40.0, 40.0),   // a continent away, same relation
  ];
  const city = buildCity(
    {
      elements: [
        ...nodes,
        {
          type: 'relation', id: 1,
          tags: { type: 'route', route: 'train', ref: 'IC', name: 'Intercity' },
          members: [
            ...nodes.map((n) => ({ type: 'node', ref: n.id, role: 'stop', lat: n.lat, lon: n.lon })),
            // deliberately off the straight line to the far point, or the
            // simplifier would drop the middle vertex as collinear
            { type: 'way', ref: 9, role: '', geometry: [
              { lat: 0.2, lon: 0.2 }, { lat: 0.8, lon: 0.2 }, { lat: 40, lon: 40 },
            ] },
          ],
        },
      ],
    },
    { id: 't7', name: 'Clipville', bbox, modes: ['train'] }
  );

  check('stops outside the box are dropped', city.stats.stations, 2);
  check('kept stops are the ones inside',
    city.stations.map((s) => s.name), ['Inside A', 'Inside B']);

  // one point past the crossing is kept on purpose, so the line reaches the edge
  const pts = decodeShape(city.lines[0].shapes[0]);
  check('geometry is clipped at the boundary', pts.length, 3);
  check('one vertex past the edge is kept so the line reaches it',
    pts.some((p) => p[0] > 39), true);
  check('clipping is skipped when no box is given',
    buildCity(
      { elements: [...nodes, { type: 'relation', id: 1,
        tags: { type: 'route', route: 'train', ref: 'IC', name: 'IC' },
        members: nodes.map((n) => ({ type: 'node', ref: n.id, role: 'stop', lat: n.lat, lon: n.lon })) }] },
      { id: 't7b', name: 'NoBox', bbox: {}, modes: ['train'] }
    ).stats.stations, 3);
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
