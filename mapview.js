// mapview.js — draws the network in SVG and handles pan/pinch.
// Geometry is the operator's real track geometry from OSM rather than a
// schematic: it is honest about where you actually are, which matters more
// when you're standing on a street corner with no signal.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_COLOUR = '#8b939e';
const COORD_SCALE = 1e6; // must match data.js

// SVG2 lets r, font-size and stroke-width be set from CSS, so screen-constant
// sizing can come from one custom property instead of an attribute write per
// element per frame. Where that is unavailable we write the attributes as
// before — correct either way, just slower.
const CSS_SIZED = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('r', '3px');

export class MapView {
  constructor(svg) {
    this.svg = svg;
    this.viewport = svg.querySelector('#viewport');
    this.layers = {
      lines: svg.querySelector('#layer-lines'),
      links: svg.querySelector('#layer-links'),
      stations: svg.querySelector('#layer-stations'),
      labels: svg.querySelector('#layer-labels'),
      route: svg.querySelector('#layer-route'),
      me: svg.querySelector('#layer-me'),
    };
    this.k = 1; this.tx = 0; this.ty = 0;
    this.lastK = null;
    this.onStationTap = null;
    this.city = null;
    if (CSS_SIZED) svg.classList.add('css-sized');
    this._bindGestures();
  }

  /* ---- projection ---- */

  _project(lat, lon) {
    const x = (lon + 180) / 360;
    const s = Math.sin((lat * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x * 1e6, y * 1e6];
  }

  render(city) {
    this.city = city;
    for (const g of Object.values(this.layers)) g.replaceChildren();

    const pts = city.stations.map((s) => this._project(s.lat, s.lon));
    this.pos = new Map(city.stations.map((s, i) => [s.id, pts[i]]));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const seen = (x, y) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    pts.forEach(([x, y]) => seen(x, y));

    // track geometry
    const frag = document.createDocumentFragment();
    for (const line of city.lines) {
      // shapes are flat Int32Arrays of round(degrees * 1e6), read in place so
      // panning never allocates a coordinate pair.
      for (const shape of line.shapes) {
        if (shape.length < 4) continue;
        let d = '';
        for (let i = 0; i < shape.length; i += 2) {
          const [x, y] = this._project(shape[i] / COORD_SCALE, shape[i + 1] / COORD_SCALE);
          seen(x, y);
          d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        }
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        p.setAttribute('stroke', line.colour || DEFAULT_COLOUR);
        p.setAttribute('stroke-width', '3.5');
        p.setAttribute('vector-effect', 'non-scaling-stroke');
        p.setAttribute('opacity', line.colour ? '0.95' : '0.55');
        frag.appendChild(p);
      }
    }
    this.layers.lines.appendChild(frag);

    // walking interchanges
    const linkFrag = document.createDocumentFragment();
    for (const [a, b] of city.graph.links) {
      const pa = this.pos.get(a), pb = this.pos.get(b);
      if (!pa || !pb) continue;
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', `M${pa[0].toFixed(1)} ${pa[1].toFixed(1)}L${pb[0].toFixed(1)} ${pb[1].toFixed(1)}`);
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      linkFrag.appendChild(p);
    }
    this.layers.links.appendChild(linkFrag);

    // stations + labels
    this.circles = [];
    this.labels = [];
    const stFrag = document.createDocumentFragment();
    const lbFrag = document.createDocumentFragment();
    city.stations.forEach((s, i) => {
      const [x, y] = pts[i];
      const interchange = s.lines.length > 1;

      const hit = document.createElementNS(SVG_NS, 'circle');
      hit.setAttribute('cx', x); hit.setAttribute('cy', y);
      hit.setAttribute('class', 'station hit');
      hit.dataset.id = s.id;
      stFrag.appendChild(hit);

      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y);
      c.setAttribute('class', 'station' + (interchange ? ' interchange' : ''));
      c.setAttribute('pointer-events', 'none');
      stFrag.appendChild(c);

      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', x); t.setAttribute('y', y);
      t.setAttribute('class', 'slabel');
      t.textContent = s.name;
      lbFrag.appendChild(t);

      this.circles.push({ el: c, hit, interchange, x, y });
      this.labels.push({ el: t, x, y, interchange });
    });
    // Interchanges win when two labels want the same patch of screen — they are
    // the ones you navigate by. Order is fixed once here so the choice stays
    // stable from frame to frame instead of flickering as you move.
    this.labelOrder = this.labels
      .map((l, i) => i)
      .sort((a, b) => (this.labels[b].interchange ? 1 : 0) - (this.labels[a].interchange ? 1 : 0));
    this.layers.stations.appendChild(stFrag);
    this.layers.labels.appendChild(lbFrag);

    this.bounds = { minX, minY, maxX, maxY };
    this.fit();
  }

  fit(padding = 28) {
    if (!this.bounds) return;
    const r = this.svg.getBoundingClientRect();
    const { minX, minY, maxX, maxY } = this.bounds;
    const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    this.k = Math.min((r.width - padding * 2) / w, (r.height - padding * 2) / h);
    this.tx = r.width / 2 - ((minX + maxX) / 2) * this.k;
    this.ty = r.height / 2 - ((minY + maxY) / 2) * this.k;
    this._apply();
  }

  centreOn(lat, lon, k) {
    const [x, y] = this._project(lat, lon);
    const r = this.svg.getBoundingClientRect();
    if (k) this.k = k;
    this.tx = r.width / 2 - x * this.k;
    this.ty = r.height / 2 - y * this.k;
    this._apply();
  }

  _apply() {
    // The transform is applied immediately — that is what makes the gesture
    // feel attached to your finger. Everything else is coalesced onto the next
    // frame, because a pinch delivers pointermove far faster than 60 Hz and
    // without this each event paid for a full pass over every station.
    this.viewport.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.k})`);
    // Sizing is part of the transform, not part of the deferred pass — one
    // cheap write, and it keeps radii and type exactly in step with the zoom
    // instead of trailing it by a frame.
    if (CSS_SIZED) this.svg.style.setProperty('--inv', 1 / this.k);
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._refresh();
    });
  }

  _refresh() {
    const rescale = this.k !== this.lastK;
    this.lastK = this.k;
    this._cull(rescale);
  }

  // Screen-constant sizes: radii and type must not grow with the zoom.
  //
  // This is the hot path, not the render — it runs for every wheel tick and
  // every frame of a pinch. Rewriting all ~21,600 attributes of a network the
  // size of Moscow's cost ~72 ms a frame, and almost every one of those
  // elements was outside the viewport. Cull to the visible rectangle first and
  // the cost tracks what you can actually see instead of how big the city is.
  // Visibility is only written when it changes, so panning across an edge
  // touches the few elements that crossed it rather than all of them.
  _cull(rescale) {
    const k = this.k;
    const showLabels = k > 0.0016;
    const r = this.svg.getBoundingClientRect();
    const pad = 80 / k;
    const x0 = -this.tx / k - pad, x1 = (r.width - this.tx) / k + pad;
    const y0 = -this.ty / k - pad, y1 = (r.height - this.ty) / k + pad;
    const inView = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    for (const c of this.circles) {
      const vis = inView(c.x, c.y);
      if (vis !== c.shown) {
        c.shown = vis;
        c.el.setAttribute('display', vis ? 'inline' : 'none');
        c.hit.setAttribute('display', vis ? 'inline' : 'none');
      }
      if (!vis || !rescale || CSS_SIZED) continue;
      c.el.setAttribute('r', (c.interchange ? 4.6 : 3) / k);
      c.hit.setAttribute('r', 14 / k);
    }

    // Greedy placement in a grid of label-sized cells. Zoomed out, Moscow put
    // 660 labels on screen — an unreadable stack that also cost more than the
    // frame budget to maintain. One label per cell keeps the map legible and
    // caps the work at what fits on screen rather than what the city contains.
    // The grid is anchored in world space, not screen space, so panning does
    // not reshuffle which label won.
    const cellW = 112 / k, cellH = 15 / k;
    const taken = new Set();
    for (const idx of this.labelOrder) {
      const l = this.labels[idx];
      let vis = (showLabels || l.interchange) && inView(l.x, l.y);
      if (vis) {
        const cell = Math.floor(l.x / cellW) + ',' + Math.floor(l.y / cellH);
        if (taken.has(cell)) vis = false;
        else taken.add(cell);
      }
      if (vis !== l.shown) {
        l.shown = vis;
        l.el.setAttribute('display', vis ? 'inline' : 'none');
      }
      if (!vis || !rescale || CSS_SIZED) continue;
      l.el.setAttribute('font-size', 10 / k);
      l.el.setAttribute('stroke-width', 3.5 / k);
      l.el.setAttribute('x', l.x + 7 / k);
      l.el.setAttribute('y', l.y + 3.4 / k);
    }
    if (!rescale || CSS_SIZED) return;
    for (const el of this.layers.route.querySelectorAll('.endcap')) {
      el.setAttribute('r', 7 / k);
    }
    for (const el of this.layers.me.children) {
      el.setAttribute('r', (el.classList.contains('me-halo') ? 26 : 6) / k);
    }
  }

  /* ---- overlays ---- */

  showRoute(result) {
    this.layers.route.replaceChildren();
    if (!result) return;
    const seq = [];
    for (const leg of result.legs) {
      for (const s of leg.stations) {
        const p = this.pos.get(s.id);
        if (p && (!seq.length || seq[seq.length - 1] !== p)) seq.push(p);
      }
    }
    if (seq.length < 2) return;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', seq.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(''));
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    this.layers.route.appendChild(path);
    for (const p of [seq[0], seq[seq.length - 1]]) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]);
      c.setAttribute('class', 'endcap');
      this.layers.route.appendChild(c);
    }
    this.lastK = null;
    this._apply();
  }

  showMe(lat, lon) {
    const [x, y] = this._project(lat, lon);
    this.layers.me.replaceChildren();
    for (const cls of ['me-halo', 'me']) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y);
      c.setAttribute('class', cls);
      this.layers.me.appendChild(c);
    }
    this.lastK = null;
    this._apply();
  }

  /* ---- gestures ---- */

  _bindGestures() {
    const svg = this.svg;
    const pointers = new Map();
    let start = null;

    const local = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      start = this._gestureState(pointers);
      start.tx = this.tx; start.ty = this.ty; start.k = this.k;
      start.moved = 0;
      start.target = e.target;
    });

    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const now = local(e);
      pointers.set(e.pointerId, now);
      start.moved += Math.hypot(now.x - prev.x, now.y - prev.y);

      const g = this._gestureState(pointers);
      const scale = start.dist ? g.dist / start.dist : 1;
      this.k = start.k * scale;
      this.tx = g.cx - (start.cx - start.tx) * scale;
      this.ty = g.cy - (start.cy - start.ty) * scale;
      this._apply();
    });

    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && start) {
        if (start.moved < 8 && start.target?.dataset?.id) {
          this.onStationTap?.(start.target.dataset.id);
        }
        start = null;
      } else if (start) {
        const g = this._gestureState(pointers);
        Object.assign(start, g, { tx: this.tx, ty: this.ty, k: this.k });
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = this.k * factor;
      this.tx = p.x - (p.x - this.tx) * (k / this.k);
      this.ty = p.y - (p.y - this.ty) * (k / this.k);
      this.k = k;
      this._apply();
    }, { passive: false });
  }

  _gestureState(pointers) {
    const pts = [...pointers.values()];
    if (pts.length === 0) return { cx: 0, cy: 0, dist: 0 };
    if (pts.length === 1) return { cx: pts[0].x, cy: pts[0].y, dist: 0 };
    const [a, b] = pts;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}
