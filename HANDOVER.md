# HANDOVER — Interchange

Paste this into a fresh Claude Code session at the repo root, or keep it as
`HANDOVER.md` and open with "Read HANDOVER.md and pick up from Next up."

---

## What this is

A static PWA that gives you a metro map you own. You add a city once while
online; it pulls that city's rail network from OpenStreetMap, folds it into a
diagram plus a routing graph, and stores the whole thing in IndexedDB. After
that it never touches the network.

It exists because NAVITIME Transit — the app it replaces — went from a good
offline route-map tool to seven in-app purchase tiers, eSIM upsells, and
third-party ad tracking. The design constraints all follow from that: no
accounts, no subscriptions, no analytics, no ads, no telemetry of any kind.
Don't add any, and don't add a dependency that does.

## Hard constraints

- **No build step, no bundler, no npm dependencies.** Plain ES modules loaded
  with `<script type="module">`. This has to stay deployable by dragging the
  folder onto a static host. If you're reaching for a framework, don't.
- **No `localStorage` or `sessionStorage`.** All persistence is IndexedDB via
  the `store` helper in `data.js`.
- **Offline is the product.** Nothing on the critical path may require a
  network call. Fonts are system stacks specifically so there's nothing to
  fetch. If you add an asset, add it to `SHELL` in `sw.js`.
- **Overpass and Nominatim are volunteer-run.** They are called only when the
  user explicitly adds a city, and are deliberately never cached by the service
  worker. Don't add background refresh, prefetching, or retry loops beyond the
  existing mirror fallback.
- Map data is OSM, ODbL. Attribution stays in the README. Don't reproduce
  official operator schematic maps — those are copyrighted, which is the whole
  reason this renders its own geometry.

## Layout

```
index.html      app shell, all dialogs, the SVG layer stack
styles.css      chrome is deliberately grey; all colour comes from OSM line tags
app.js          UI wiring: cities, search, trip strip diagram, geolocation
data.js         geocode -> Overpass -> station merging -> graph -> IndexedDB
graph.js        Dijkstra over (station, line) states; leg collapsing
mapview.js      SVG render, pan/pinch, screen-constant sizing, overlays
builder.worker.js  fetch -> parse -> buildCity -> save, off the main thread
sw.js           precaches the shell, sequentially, tolerating misses
tests/network.test.mjs   node-only regression tests, no browser needed
```

## Decisions worth not re-litigating

**Routing state is `(station, line)`, not `station`.** A plain
station-keyed Dijkstra hands back routes with free transfers, which produces
absurd six-change itineraries. The state carries the line you arrived on so a
240 s interchange penalty can be charged when it changes. See
`TRANSFER_PENALTY` in `data.js` and the `changing` check in `graph.js`.

**Station merging is name-and-distance based.** OSM has one stop node per
platform per direction. Stops sharing a normalised name within 900 m collapse
into one station; unnamed ones merge within 80 m. The name normaliser strips
the word for "station" in several languages — extend that list rather than
special-casing cities.

**Distinct stations within 350 m get a walking edge.** This is how
out-of-station interchanges (Bank–Monument, Châtelet–Les Halles) work at all.
Built with a spatial hash so it stays roughly linear.

**Building a city happens in a worker.** Adding Moscow is about 12.7 s of
unbroken main-thread work — 2.7 s decoding and parsing 223 MB of response text,
then 9.8 s in `buildCity`. The parse is why a worker rather than chunking: yields
can be sprinkled through `buildCity`, but `JSON.parse` runs to completion or not
at all, so a chunked version would still freeze for seconds. Measured with the
same 20 ms sampler on both sides: built inline the sampler fired **once** in
12.7 s; through the worker it fired 178 times at a median of 20.1 ms, its exact
target.

`data.js` needed no changes to run there — it touches `indexedDB`, `fetch` and
`Math`, never the DOM — and module workers need no bundler, which is the only
reason this fits the no-build-step rule. The worker writes the finished city to
IndexedDB and posts back just the stats; the page reads it back in ~25 ms, which
beats structured-cloning the network across the boundary. Migration runs there
too, and is awaited rather than fired and forgotten, because the renderer reads
packed geometry and cannot draw an unconverted record at all.

`runInWorker` returns `null` when the worker is unavailable and the caller
builds inline exactly as before. Both branches are exercised: a missing worker
file resolves through `onerror` to the fallback, and a browser that ignores
`type: 'module'` is caught by the 4 s handshake timeout rather than hanging.

**Screen-constant sizing comes from CSS, not from JavaScript.** SVG2 allows
`r`, `font-size` and `stroke-width` to be set from CSS, so `mapview` writes a
single `--inv` custom property (1/scale) on the `<svg>` and the stylesheet
derives every radius and type size from it. Tokyo keeps 2,802 station circles on
screen at once; writing `r` on each per frame cost more than the entire frame
budget, and this replaces 5,604 attribute writes with one. `--inv` is set in
`_apply` alongside the transform rather than in the deferred pass, so sizing
never trails the zoom by a frame. `CSS_SIZED` feature-detects it and the old
attribute path still runs where it is unsupported — check both if you touch
either.

**The network is clipped to the bounding box that was asked for.** Overpass
selects a relation if *any* member falls in the box and `out geom` then returns
that relation whole. Ask for Moscow with suburban rail and you get Russian
Railways services entire: 59% of the stations and 89% of the geometry sat
outside the requested box, including a route from Khabarovsk 6,500 km away, and
the router would happily plan you a 9,340-minute journey on it. `clipShapes`
and the `within` test in `data.js` drop them. This is the single biggest win in
the whole exercise and it is a correctness fix before it is a size fix — a
Moscow metro map with Khabarovsk on it is simply wrong. One vertex past each
crossing is kept on purpose so lines still run to the edge of the map.

**Stored geometry is simplified and packed, not faithful.** Douglas-Peucker at
10 m, then one `Int32Array` per polyline of `round(degrees * 1e6)`. Roughly
0.11 m accurate, 8 bytes a point instead of about 24. Nothing routes off
`line.shapes` — it has exactly one consumer, the renderer — so this cannot
affect an itinerary. Records written before this carry no `format` marker and
are converted on first open by `migrateCity`, which needs no network.

**Labels are placed greedily in a grid, not all drawn.** Zoomed out, Moscow put
660 labels on screen: unreadable, and more than the frame budget to maintain.
One label per cell, interchanges winning ties, cuts that to under 200 and makes
the map legible. The grid is anchored in world space so panning does not
reshuffle which label won.

**Way geometry is chained before it is stored.** OSM lists a route
relation's ways in travel order but each way keeps its own digitisation
direction, so consecutive ways meet end-to-start only about 80% of the time.
Stored one-way-per-shape that is 374,133 `<path>` elements for Moscow and a map
that will not pan; chained on the shared endpoint it is 1,165. `chainShapes` in
`data.js` does this. It is not cosmetic — it is the difference between 381,785
DOM nodes and 8,801. Do not "simplify" it back to pushing raw member geometry.

**Times are modelled, not real.** Distance over a per-mode average speed, 25 s
dwell per stop, 45 s plus walk time for a foot transfer. The UI labels them
"estimated" because they are. Constants sit at the top of `data.js`.

**The map is geographic, not schematic.** Beck-style octilinear layout from raw
geometry is a hard research problem (see LOOM — Bast, Brosi, Storandt).
Geographic also has a real offline advantage: it matches what you see when you
come up the stairs.

## State: what is and isn't verified

Verified:
- `node tests/network.test.mjs` — 29 assertions covering station merging, line
  attribution, change counting, leg collapsing, walking interchanges, the
  platform-only tagging fallback, and way chaining. All passing.
- Every element `app.js` queries exists in `index.html` (checked by script).
- All modules pass `node --check`.
- **Run against real Overpass data.** Lisbon, Prague and Mexico City through a
  Node harness; Lisbon, Bangkok and Moscow through the browser UI end to end.
  Both paths agree exactly — Lisbon builds 173 stations / 25 routes / 13 lines
  either way. Itineraries were checked against the real networks and are right,
  including a three-leg Mexico City trip over Línea B, 1, 2 and the Tren Ligero.
- The SVG renderer draws a real network correctly, with no console errors.
- Station merging holds up on real data: no unnamed stations in Lisbon or
  Prague, one in Mexico City, and no station left without a line.

- **Benchmarked on a cleared store** against the densest rail networks there
  are — Tokyo, Moscow, Paris, New York, Seoul, Greater London and Lisbon.

What the fixes were worth, before and after:

| | stations | points | store | per interaction | heap |
|---|---|---|---|---|---|
| Lisbon before | 173 | 8,731 | 0.3 MB | 3.8 ms | 4 MB |
| Lisbon after | 173 | 868 | ~0.1 MB | 3.9 ms | 15 MB |
| London before | 1,319 | 963,098 | 23.6 MB | 22.1 ms | 104 MB |
| London after | 916 | 50,142 | 0.4 MB | 7.3 ms | 16 MB |
| Moscow before | 2,402 | 5,450,962 | 132.5 MB | 60.0 ms | 945 MB |
| Moscow after | 975 | 104,519 | 0.8 MB | 8.6 ms | 16 MB |

And the densest networks, all after:

| | stations | labels drawn | per interaction | worst | pan |
|---|---|---|---|---|---|
| Tokyo | 1,443 | 238 | 10.9 ms | 13.9 ms | 0.7 ms |
| Paris | 972 | 151 | 7.8 ms | 9.1 ms | 0.4 ms |
| New York | 681 | 128 | 5.4 ms | 7.8 ms | 0.3 ms |
| Seoul | 572 | 117 | 5.5 ms | 7.4 ms | 0.3 ms |

Tokyo is the worst case in the world for this app and it sits inside the 16.7 ms
frame budget with its worst frame, not just its median. Seven cities together
occupy 13.7 MB. Routing was checked by hand on each: Seoul reaches Gimpo via
line 2, line 1, AREX and the Goldline; Paris runs M12 to RER C to RER B; New
York goes 5 then 6. They are correct journeys, not merely paths.

**How to measure this, because it is easy to get wrong.** Figures are medians
over 12–14 events with `requestAnimationFrame` held synchronous for the *whole*
run, city loads included. Two traps cost real time here: a background tab pauses
rAF, so the deferred pass never runs and every label stays on screen — the tell
is `labelsShown` equalling `labelsTotal`; and calling `getBBox()` inside the
timing loop forces a layout the wheel event just dirtied, which inflated Paris
from 7.8 ms to 94.7 ms. Measure the handler, and check `labelsShown` first.

**Not verified — start here:**
- Pinch-zoom is written against Pointer Events but untested on iOS Safari.
- Storage persistence on iOS is asserted from documented behaviour, not
  observed. Much less likely to bite now that a big city is under 1 MB.
- The first zoom after opening a large city costs ~35–45 ms for two or three
  frames — the first cull, plus GC from the build. It settles immediately and
  is well below the threshold of the rest of the work, but it is real.
- Building Moscow blocks for ~4 s in Node and ~10 s in the browser. Tokyo is
  0.3 s and Paris 1.2 s, so this is Moscow's 222 MB response rather than the
  algorithm. The step has UI feedback, but it is a synchronous freeze inside
  `buildCity`.
- Paint cost has never been measured, only the app's own per-event work. The
  pane used for testing runs as a background tab, which never composites, so
  real frame intervals could not be sampled. Worth checking on a real device.
- Overpass mirrors disagree with each other. Observed directly: for one
  identical Lisbon query `overpass-api.de` returned 554 elements,
  `kumi.systems` returned HTTP 500, and `overpass.osm.ch` returned 200 with zero
  elements. `fetchNetwork` now treats an empty response as a mirror failure and
  moves on, but if every mirror answers empty there is no way to tell a busy
  server from a city with no railways — `emptyNetworkMessage` says both might be
  true rather than blaming the map. Expect this when testing repeatedly: the
  rate limit is per IP and clears in a minute or two.
- `manifest.webmanifest` and the three files under `icons/` are listed in
  `SHELL` but do not exist, so the install always logs those as misses and the
  app is not installable as a PWA yet.

## Two bugs already fixed — don't reintroduce

1. A handler bound to a selector that didn't exist threw at module top level
   and killed every subsequent binding, so the entire UI was dead with one
   console error. All click handlers now go through the `on()` helper in
   `app.js`, which warns instead of throwing. Keep using it.
2. `cache.addAll()` in the service worker rejects the whole install if any one
   request fails, which happens on serial dev servers. Install now caches
   sequentially and logs misses. Serve with
   `python3 -m http.server 8000 --protocol HTTP/1.1` or `npx serve`.

## Running it

```bash
node tests/network.test.mjs                        # logic tests
python3 -m http.server 8000 --protocol HTTP/1.1    # then localhost:8000
```

Service workers need a real origin — `file://` won't work.

**Serve with `Cache-Control: no-store` while iterating, or you will lose hours.**
`python3 -m http.server` sends `Last-Modified` and no `Cache-Control`, so Chrome
heuristically caches ES modules. Unregistering the service worker is not enough,
clearing the Cache Storage is not enough, and a forced reload is not enough:
Chrome will still hand the module loader a stale `app.js` it cached earlier.
This cost three separate debugging cycles here, and the symptom is always the
same — a fix that provably works under `node` does nothing in the browser, with
no error to explain why. Check `performance.getEntriesByType('resource')` and
compare `decodedBodySize` against the file on disk before believing anything.
A twenty-line threading server that sends `no-store` removes the whole class of
problem; failing that, serve from a port you have not used before, since the
HTTP cache is keyed by origin.

**Bump `CACHE` in `sw.js` whenever a shell file changes.** The fetch handler is
cache-first with no revalidation, so a client that has already installed serves
the old modules forever until that constant changes and `activate` sweeps the
previous cache. It is `interchange-v6` as of the background builder.

Good first cities to test with: Lisbon or Prague (small, well mapped, fast
query). Tokyo works but the query is heavy and needs suburban rail enabled to
be useful. Some Latin American and African networks tag platforms but not stop
positions — the parser falls back, but stop ordering gets rough. That fallback
path needs real-world testing.

## Next up, in order

1. **Stop downloading 223 MB to keep 8 MB of it.** Clipping currently discards
   89% of Moscow's geometry *after* it crosses the network, because
   `.r out body geom` emits every member way of every matching relation in full,
   Trans-Siberian track included. Restricting the emitted ways and nodes to the
   box instead —

   ```
   rel[...](bbox)->.r;
   .r out body;
   way(r.r)(bbox); out geom;
   node(r.r)(bbox); out body;
   ```

   — should cut it by roughly an order of magnitude, shrinking the download
   wait, the build, and the load on a volunteer server at once. The catch is
   that members stop carrying inline geometry, so `buildCity` has to join ways
   by ref. That is the part every test leans on, so do it on its own and
   re-verify all seven cities.
2. **Label collision is improved, not solved.** Greedy grid placement keeps the
   count sane, but nothing yet stops a label sitting on top of a line, and the
   winner within a cell is whichever interchange comes first rather than the
   most important station.
3. **Update rather than re-download.** Re-run the query for a saved city and
   diff, so a refresh doesn't cost a full download.
4. **Export/import a city pack** as JSON, so a travel companion can load a
   network without hitting Overpass at all. Also makes fixture capture easy.
5. **GTFS import** for real timetables, as an optional per-city pack so the
   base download stays small. Only for cities that publish feeds.
6. **Octilinear rendering.** The ambitious one. Snap edges to 45° increments
   with a local search pass while keeping stations near true positions.

## Style notes

Comments in this codebase explain *why*, not what — keep that. UI copy is
sentence case, active voice, and never apologises; errors say what happened and
what to do about it ("No rail lines are mapped here for the modes you picked.
Try adding tram or suburban rail."). The interface has exactly one accent
colour, a sodium yellow, used only for cached/lit states; everything else grey
so the operators' line colours carry the diagram. Don't add a second accent.
