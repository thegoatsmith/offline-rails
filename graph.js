// graph.js — shortest path with the thing every naive transit router forgets:
// changing trains costs real time, so the state is (station, line you're on),
// not just (station).

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function route(city, fromId, toId) {
  const { adj, transferPenalty } = city.graph;
  if (fromId === toId) return null;

  const best = new Map();
  const came = new Map();
  const heap = new Heap();
  const startKey = fromId + '|start';
  best.set(startKey, 0);
  heap.push({ f: 0, station: fromId, line: 'start', key: startKey });

  let endKey = null;
  while (heap.size) {
    const cur = heap.pop();
    if (cur.f > (best.get(cur.key) ?? Infinity)) continue;
    if (cur.station === toId) { endKey = cur.key; break; }

    for (const edge of adj[cur.station] || []) {
      const changing = cur.line !== 'start' && cur.line !== edge.line;
      const penalty = changing && !edge.walk ? transferPenalty : 0;
      const f = cur.f + edge.cost + penalty;
      const key = edge.to + '|' + edge.line;
      if (f < (best.get(key) ?? Infinity)) {
        best.set(key, f);
        came.set(key, { prev: cur.key, station: cur.station, edge });
        heap.push({ f, station: edge.to, line: edge.line, key });
      }
    }
  }

  if (endKey == null) return null;
  return toLegs(city, came, endKey, best.get(endKey), fromId);
}

// Walk the parent chain back, then collapse consecutive edges on the same
// line into legs — which is how a person actually describes a journey.
function toLegs(city, came, endKey, seconds, fromId) {
  const byId = new Map(city.stations.map((s) => [s.id, s]));
  const steps = [];
  let key = endKey;
  while (came.has(key)) {
    const { prev, station, edge } = came.get(key);
    steps.push({ from: station, to: edge.to, edge });
    key = prev;
  }
  steps.reverse();

  const legs = [];
  for (const step of steps) {
    const last = legs[legs.length - 1];
    if (last && last.line === step.edge.line) {
      last.stations.push(byId.get(step.to));
      last.seconds += step.edge.cost;
    } else {
      legs.push({
        line: step.edge.line,
        walk: !!step.edge.walk,
        metres: step.edge.metres,
        ref: step.edge.ref,
        colour: step.edge.colour,
        mode: step.edge.mode,
        stations: [byId.get(step.from), byId.get(step.to)],
        seconds: step.edge.cost,
      });
    }
  }

  const changes = legs.filter((l) => !l.walk).length - 1;
  return {
    legs,
    seconds,
    changes: Math.max(0, changes),
    from: byId.get(fromId),
    to: legs.length ? legs[legs.length - 1].stations.slice(-1)[0] : null,
  };
}

export function nearest(city, lat, lon, limit = 1) {
  const scored = city.stations
    .map((s) => ({ s, d: dist(s, lat, lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
  return limit === 1 ? scored[0] : scored;
}

function dist(s, lat, lon) {
  const dLat = (s.lat - lat) * 110574;
  const dLon = (s.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
