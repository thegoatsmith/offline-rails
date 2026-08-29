// tests/network.test.ts — run with: bun test
//
// These exercise the parts that have no browser in them: station merging,
// graph construction and routing. Synthetic Overpass payloads, no network.

import { describe, expect, test } from 'bun:test';

import {
  buildCity,
  decodeShape,
  fetchNetwork,
  migrateCity,
  OVERPASS,
  placeId,
  simplify,
} from '../src/lib/data.ts';
import { nearest, route } from '../src/lib/graph.ts';
import type { City, OverpassElement, OverpassMember, OverpassResponse } from '../src/lib/types.ts';

const node = (id: number, name: string, lat: number, lon: number): OverpassElement => ({
  type: 'node',
  id,
  lat,
  lon,
  tags: { name, railway: 'stop' },
});

const stopMember =
  (nodes: OverpassElement[]) =>
  (id: number): OverpassMember => {
    const n = nodes.find((x) => x.id === id)!;
    return { type: 'node', ref: id, role: 'stop', lat: n.lat, lon: n.lon };
  };

const relation =
  (nodes: OverpassElement[]) =>
  (id: number, ref: string, colour: string, ids: number[]): OverpassElement => ({
    type: 'relation',
    id,
    tags: { type: 'route', route: 'subway', ref, name: `${ref} line`, colour },
    members: ids.map(stopMember(nodes)),
  });

const build = (elements: OverpassElement[], meta: Partial<Parameters<typeof buildCity>[1]> = {}) =>
  buildCity({ elements } as OverpassResponse, {
    id: 't',
    name: 'Test',
    bbox: {},
    modes: ['subway'],
    ...meta,
  });

const P = (lat: number, lon: number) => ({ lat, lon });
const way = (ref: number, geometry: { lat: number; lon: number }[]): OverpassMember => ({
  type: 'way',
  ref,
  role: '',
  geometry,
});

describe('station merging and attribution', () => {
  const nodes = [
    node(1, 'Westgate', 51.5, -0.14),
    node(2, 'Central', 51.505, -0.13),
    node(3, 'Eastcote', 51.51, -0.12),
    node(4, 'Northfield', 51.515, -0.132),
    node(5, 'Central', 51.5051, -0.1301), // same name, different platform node
    node(6, 'Southbank', 51.498, -0.128),
  ];
  const rel = relation(nodes);
  const city: City = build(
    [...nodes, rel(1, 'A', '#d64545', [1, 2, 3]), rel(2, 'B', '#3a72c4', [4, 5, 6])],
    { id: 't1', name: 'Testville' },
  );

  test('duplicate platform nodes merge into one station', () => {
    expect(city.stats.stations).toBe(5);
  });

  test('shared station carries both lines', () => {
    expect(city.stations.find((s) => s.name === 'Central')!.lines.map((l) => l.label)).toEqual([
      'A',
      'B',
    ]);
  });

  test('cross-network trip needs one change', () => {
    expect(route(city, 's0', 's4')!.changes).toBe(1);
  });

  test('legs are collapsed per line', () => {
    expect(route(city, 's0', 's4')!.legs.map((l) => l.ref)).toEqual(['A', 'B']);
  });

  test('same-line trip has no changes', () => {
    expect(route(city, 's0', 's2')!.changes).toBe(0);
  });

  test('nearest station lookup', () => {
    expect(nearest(city, 51.5045, -0.1315)!.s.name).toBe('Central');
  });
});

describe('out-of-station interchange via a walking link', () => {
  const nodes = [
    node(1, 'Westgate', 51.5, -0.14),
    node(2, 'Central', 51.505, -0.13),
    node(7, 'Riverside', 51.5052, -0.1277), // ~160 m from Central, different name
    node(8, 'Docks', 51.507, -0.121),
  ];
  const rel = relation(nodes);
  const city = build([...nodes, rel(1, 'A', '#3f9a5c', [1, 2]), rel(2, 'C', '#e0b530', [7, 8])], {
    id: 't2',
    name: 'Linkville',
  });

  test('nearby distinct stations get one walking link', () => {
    expect(city.graph.links.length).toBe(1);
  });

  test('route walks between the two systems', () => {
    expect(route(city, 's0', 's3')!.legs.map((l) => (l.walk ? 'walk' : l.ref))).toEqual([
      'A',
      'walk',
      'C',
    ]);
  });

  test('walk leg reports a distance', () => {
    expect(typeof route(city, 's0', 's3')!.legs[1]!.metres).toBe('number');
  });
});

test('falls back to platform roles when no stop roles exist', () => {
  const nodes: OverpassElement[] = [
    { type: 'node', id: 1, lat: 48.85, lon: 2.35, tags: { name: 'Alpha', railway: 'platform' } },
    { type: 'node', id: 2, lat: 48.86, lon: 2.36, tags: { name: 'Beta', railway: 'platform' } },
  ];
  const city = build(
    [
      ...nodes,
      {
        type: 'relation',
        id: 9,
        tags: { type: 'route', route: 'tram', ref: 'T1', name: 'T1' },
        members: nodes.map((n) => ({
          type: 'node' as const,
          ref: n.id,
          role: 'platform',
          lat: n.lat,
          lon: n.lon,
        })),
      },
    ],
    { id: 't3', name: 'Platformville', modes: ['tram'] },
  );
  expect(city.stats.stations).toBe(2);
});

describe('way geometry is chained into continuous polylines', () => {
  // OSM lists a relation's ways in travel order but each way keeps its own
  // digitisation direction, so consecutive ways often meet end-to-end or
  // start-to-start. Drawn unmerged that is one <path> per way — 374k of them
  // on a network the size of Moscow, which is why the map stopped panning.
  const city = build([
    {
      type: 'relation',
      id: 1,
      tags: { type: 'route', route: 'subway', ref: 'M', name: 'M line' },
      // deliberately a zigzag: collinear points would be removed again by the
      // simplifier downstream and the chaining assertion would prove nothing
      members: [
        way(1, [P(0, 0), P(0.001, 0.001)]), // forward
        way(2, [P(0, 0.002), P(0.001, 0.001)]), // reversed: meets previous end at ITS end
        way(3, [P(0, 0.002), P(0.001, 0.003)]), // forward again
        way(4, [P(9, 9), P(9, 9.0005)]), // genuinely disconnected
      ],
    },
  ]);
  const shapes = city.lines[0]!.shapes.map(decodeShape);

  test('contiguous ways merge into one polyline', () => {
    expect(shapes.length).toBe(2);
  });

  test('merged polyline runs end to end', () => {
    expect(shapes.find((s) => s.length > 2)).toEqual([
      [0, 0],
      [0.001, 0.001],
      [0, 0.002],
      [0.001, 0.003],
    ]);
  });

  test('a real gap stays a separate polyline', () => {
    expect(shapes.find((s) => s.length === 2)).toEqual([
      [9, 9],
      [9, 9.0005],
    ]);
  });

  test('shapes are stored as typed arrays', () => {
    expect(city.lines[0]!.shapes[0]).toBeInstanceOf(Int32Array);
  });
});

describe('geometry is simplified and compacted', () => {
  // A detour of a few metres is below what anyone can see at city zoom and is
  // most of the 5.4 million points Moscow used to store. A real corner is not.
  const straightish: [number, number][] = [
    [0, 0],
    [0.0000045, 0.5],
    [0, 1],
  ]; // ~0.5 m off the line
  const corner: [number, number][] = [
    [0, 0],
    [0.0009, 0.5],
    [0, 1],
  ]; // ~100 m off the line

  test('a sub-tolerance wobble is dropped', () => {
    expect(simplify(straightish, 10).length).toBe(2);
  });

  test('a real corner survives', () => {
    expect(simplify(corner, 10).length).toBe(3);
  });

  test('endpoints always survive', () => {
    expect(simplify(straightish, 10)).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  test('too short to simplify is returned as is', () => {
    expect(
      simplify(
        [
          [1, 1],
          [2, 2],
        ],
        10,
      ).length,
    ).toBe(2);
  });

  test('encoding round-trips within ~0.11 m', () => {
    const city = build(
      [
        {
          type: 'relation',
          id: 1,
          tags: { type: 'route', route: 'subway', ref: 'M', name: 'M' },
          members: [way(9, [P(51.5074123, -0.1278456), P(51.5, -0.2)])],
        },
      ],
      { id: 't5', name: 'Roundtrip' },
    );
    const back = decodeShape(city.lines[0]!.shapes[0]!)[0]!;
    expect(Math.max(Math.abs(back[0] - 51.5074123), Math.abs(back[1] - -0.1278456))).toBeLessThan(
      1e-6,
    );
    expect(city.format).toBe(2);
  });
});

describe('old records migrate without a network', () => {
  const legacy = {
    id: 'old',
    name: 'Legacy',
    bbox: {},
    modes: ['subway'],
    stations: [],
    graph: { adj: {}, links: [], transferPenalty: 240 },
    lines: [
      {
        id: 'l0',
        ref: 'M',
        shapes: [
          [
            [0, 0],
            [0.0000045, 0.5],
            [0, 1],
          ],
        ],
      },
    ],
  } as unknown as City;

  test('a pre-format record reports as migrated', () => {
    expect(migrateCity(legacy)).toBe(true);
  });

  test('migration encodes the geometry', () => {
    expect(legacy.lines[0]!.shapes[0]).toBeInstanceOf(Int32Array);
  });

  test('migration simplifies too', () => {
    expect(legacy.lines[0]!.shapes[0]!.length / 2).toBe(2);
  });

  test('migration is idempotent', () => {
    expect(migrateCity(legacy)).toBe(false);
  });
});

describe('the network is clipped to the box that was asked for', () => {
  // Overpass returns a whole relation if any one member is in the box, so a
  // long-distance service that merely calls at the city drags its entire route
  // in with it. Moscow arrived with 59% of its stations and 89% of its geometry
  // outside the requested box, one of them 6,500 km away in Khabarovsk.
  const bbox = { south: 0, north: 1, west: 0, east: 1 };
  const nodes = [
    node(1, 'Inside A', 0.2, 0.2),
    node(2, 'Inside B', 0.8, 0.8),
    node(3, 'Far Away', 40.0, 40.0), // a continent away, same relation
  ];
  const city = build(
    [
      ...nodes,
      {
        type: 'relation',
        id: 1,
        tags: { type: 'route', route: 'train', ref: 'IC', name: 'Intercity' },
        members: [
          ...nodes.map((n) => stopMember(nodes)(n.id)),
          // deliberately off the straight line to the far point, or the
          // simplifier would drop the middle vertex as collinear
          way(9, [P(0.2, 0.2), P(0.8, 0.2), P(40, 40)]),
        ],
      },
    ],
    { id: 't7', name: 'Clipville', bbox, modes: ['train'] },
  );

  test('stops outside the box are dropped', () => {
    expect(city.stats.stations).toBe(2);
  });

  test('kept stops are the ones inside', () => {
    expect(city.stations.map((s) => s.name)).toEqual(['Inside A', 'Inside B']);
  });

  test('geometry is clipped at the boundary', () => {
    expect(decodeShape(city.lines[0]!.shapes[0]!).length).toBe(3);
  });

  test('one vertex past the edge is kept so the line reaches it', () => {
    expect(decodeShape(city.lines[0]!.shapes[0]!).some((p) => p[0] > 39)).toBe(true);
  });

  test('clipping is skipped when no box is given', () => {
    expect(
      build(
        [
          ...nodes,
          {
            type: 'relation',
            id: 1,
            tags: { type: 'route', route: 'train', ref: 'IC', name: 'IC' },
            members: nodes.map((n) => stopMember(nodes)(n.id)),
          },
        ],
        { id: 't7b', name: 'NoBox', modes: ['train'] },
      ).stats.stations,
    ).toBe(3);
  });
});

describe('way geometry can arrive separately from the relation', () => {
  // Asking Overpass for a relation with `out geom` returns every member way in
  // full, however far it runs beyond the city. Fetching the ways separately and
  // bounding them to the box is far smaller, but then members carry only a ref.
  // Both shapes of response have to build the same map.
  const line = [P(0, 0), P(0.001, 0.001), P(0, 0.002)];

  const inline = build([
    {
      type: 'relation',
      id: 1,
      tags: { type: 'route', route: 'subway', ref: 'M', name: 'M' },
      members: [way(9, line)],
    },
  ]);

  const separate = build([
    {
      type: 'relation',
      id: 1,
      tags: { type: 'route', route: 'subway', ref: 'M', name: 'M' },
      members: [{ type: 'way', ref: 9, role: '' }], // no geometry here
    },
    { type: 'way', id: 9, geometry: line }, // it arrives on its own
  ]);

  test('geometry resolved by ref matches inline geometry', () => {
    expect(decodeShape(separate.lines[0]!.shapes[0]!)).toEqual(
      decodeShape(inline.lines[0]!.shapes[0]!),
    );
  });

  test('a member with no geometry anywhere is skipped, not crashed on', () => {
    expect(
      build([
        {
          type: 'relation',
          id: 1,
          tags: { type: 'route', route: 'subway', ref: 'M', name: 'M' },
          members: [{ type: 'way', ref: 404, role: '' }],
        },
      ]).lines.length,
    ).toBe(0);
  });
});

describe('place results are identified by OSM identity, not by name', () => {
  // Searching Moscow returns the city and the federal subject under the same
  // display_name — relations 102269 and 2555133. Keying a list on the name
  // crashed the whole add-city sheet with Svelte's each_key_duplicate.
  const moscowCity = {
    osm_type: 'relation',
    osm_id: 102269,
    place_id: 195843076,
    lat: '55.6',
    lon: '37.6',
  };
  const moscowOblast = {
    osm_type: 'relation',
    osm_id: 2555133,
    place_id: 195720955,
    lat: '55.7',
    lon: '37.6',
  };

  test('two rows sharing a display name still get different ids', () => {
    expect(placeId(moscowCity)).not.toBe(placeId(moscowOblast));
  });

  test('the id is the OSM type and id when present', () => {
    expect(placeId(moscowCity)).toBe('relation/102269');
  });

  test('falls back to place_id when OSM identity is missing', () => {
    expect(placeId({ place_id: 42, lat: '1', lon: '2' })).toBe('place/42');
  });

  test('falls back to coordinates when a row carries neither', () => {
    expect(placeId({ lat: '1.5', lon: '-0.1' })).toBe('at/1.5,-0.1');
  });

  test('an id is stable for the same row', () => {
    expect(placeId(moscowCity)).toBe(placeId({ ...moscowCity }));
  });
});

describe('an empty answer is only believed when every mirror agrees', () => {
  // The failure this encodes: overpass.osm.ch answers 200 with zero elements for
  // queries the others serve fully, and sitting last in the mirror list its
  // answer was the one taken as truth. Two mirrors were down, the third lied,
  // and the app told the user their city has no railways.
  const bbox = { south: 0, north: 1, west: 0, east: 1 };
  const withFetch = async <T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
    }
  };
  const ok = (elements: unknown[]) =>
    new Response(JSON.stringify({ elements }), { status: 200 }) as Response;

  test('a failing mirror falls through to a working one', async () => {
    const seen: string[] = [];
    const res = await withFetch(
      (async (url: string) => {
        seen.push(new URL(url).hostname);
        return seen.length === 1 ? new Response('nope', { status: 500 }) : ok([{ id: 1 }]);
      }) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    expect(res.elements.length).toBe(1);
    expect(seen.length).toBe(2);
  });

  test('a third mirror is tried when the first two fail', async () => {
    const seen: string[] = [];
    const res = await withFetch(
      (async (url: string) => {
        seen.push(new URL(url).hostname);
        return seen.length < 3 ? new Response('nope', { status: 500 }) : ok([{ id: 1 }]);
      }) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    expect(res.elements.length).toBe(1);
    expect(seen.length).toBe(3);
  });

  // overpass.osm.ch answered 200 with zero elements for queries the others
  // served fully, and sitting last its answer was the one believed. It is not a
  // mirror to reach for again the next time the list looks short.
  test('the mirror that lied is not in the list', () => {
    expect(OVERPASS.map((e) => new URL(e).hostname)).not.toContain('overpass.osm.ch');
  });

  test('a working first mirror is not followed by a second request', async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls++;
        return ok([{ id: 1 }]);
      }) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    expect(calls).toBe(1);
  });

  test('every mirror empty is reported as empty, not as an outage', async () => {
    const res = await withFetch((async () => ok([])) as unknown as typeof fetch, () =>
      fetchNetwork(bbox, ['subway']),
    );
    expect(res.elements.length).toBe(0);
  });

  test('a failure plus an empty answer is an outage, not an empty city', async () => {
    let n = 0;
    const call = withFetch(
      (async () => {
        n++;
        return n === 1 ? new Response('nope', { status: 500 }) : ok([]);
      }) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    expect(call).rejects.toThrow(/mirror failed/i);
  });

  test('all mirrors failing is an outage', async () => {
    const call = withFetch(
      (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    expect(call).rejects.toThrow(/mirror failed/i);
  });
});

describe('an outage says which mirror failed and how', () => {
  // "Every OpenStreetMap mirror is busy" was true of load and of nothing else.
  // When overpass.kumi.systems started answering 502 and overpass-api.de was
  // refusing the request outright, the message still said "busy" and named
  // neither host, so the only way to find out which mirror was broken was to
  // reproduce the fetches by hand outside the app.
  const bbox = { south: 0, north: 1, west: 0, east: 1 };
  const withFetch = async <T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
    }
  };
  // A rejection is the assertion here, so narrow to it rather than letting the
  // union of "threw" and "resolved" leak into every expectation below.
  const rejection = (p: Promise<unknown>): Promise<Error> =>
    p.then(
      () => {
        throw new Error('expected fetchNetwork to reject');
      },
      (e: unknown) => e as Error,
    );

  const byHost = (statuses: Record<string, number>) =>
    (async (url: string) =>
      new Response('no', {
        status: statuses[new URL(url).hostname] ?? 500,
      })) as unknown as typeof fetch;

  test('every mirror it tried is named', async () => {
    const call = withFetch(byHost({}), () => fetchNetwork(bbox, ['subway']));
    const err = await rejection(call);
    for (const endpoint of OVERPASS) {
      expect(err.message).toContain(new URL(endpoint).hostname);
    }
  });

  test('each mirror reports its own status rather than the last one', async () => {
    const hosts = OVERPASS.map((e) => new URL(e).hostname);
    const call = withFetch(byHost({ [hosts[0]!]: 502, [hosts[1]!]: 429 }), () =>
      fetchNetwork(bbox, ['subway']),
    );
    const err = await rejection(call);
    expect(err.message).toMatch(new RegExp(`${hosts[0]!.replace(/\./g, '\\.')}[^;]*502`));
    expect(err.message).toMatch(new RegExp(`${hosts[1]!.replace(/\./g, '\\.')}[^;]*busy`));
  });

  test('a mirror that could not be reached says so instead of showing a status', async () => {
    const call = withFetch(
      (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    const err = await rejection(call);
    expect(err.message).toMatch(/could not be reached/);
  });

  test('a mirror that answered with nothing is distinguished from one that failed', async () => {
    const hosts = OVERPASS.map((e) => new URL(e).hostname);
    const call = withFetch(
      (async (url: string) =>
        new URL(url).hostname === hosts[0]
          ? new Response(JSON.stringify({ elements: [] }), { status: 200 })
          : new Response('no', { status: 500 })) as unknown as typeof fetch,
      () => fetchNetwork(bbox, ['subway']),
    );
    const err = await rejection(call);
    expect(err.message).toMatch(new RegExp(`${hosts[0]!.replace(/\./g, '\\.')}[^;]*nothing`));
  });
  test('the progress note names why a mirror was dropped, not just that it was', async () => {
    const notes: string[] = [];
    await withFetch(byHost({}), () =>
      fetchNetwork(bbox, ['subway'], (t) => notes.push(t)).catch(() => undefined),
    );
    expect(notes.some((n) => /returned 500/.test(n))).toBe(true);
  });
});
