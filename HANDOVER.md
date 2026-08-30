# HANDOVER — Offline Rails

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

- **The output must stay a plain static folder.** There is a build step now
  (Bun) and there are dependencies, but `dist/` is still just files: no server,
  no runtime, no edge functions. Cloudflare Pages serves it as-is. Keep it that
  way — the moment deployment needs anything running, the offline promise gets
  harder to keep than it is worth.
- **No `localStorage` or `sessionStorage`.** All persistence is IndexedDB via
  the `store` helper in `src/lib/data.ts`.
- **Offline is the product.** Nothing on the critical path may require a
  network call. Fonts are system stacks specifically so there's nothing to
  fetch. If you add an asset, add it to `SHELL` in `src/sw.ts`.
- **The mirror walk was made parallel on 2026-08-29, reversing a documented
  decision.** It had been sequential specifically so that one city add cost one
  volunteer server one query; it now costs three servers a query each, two of
  which are aborted. Aborting closes the socket but does not undo work Overpass
  has already begun, so treat the load as three full queries, not one and two
  cancellations. What bought the reversal: with `kumi.systems` answering 502 and
  `overpass-api.de` intermittently hanging, the sequential walk spent 15s+ per
  dead mirror before trying the next, and there is no client-side deadline on
  the fetch. If the load ever needs winning back, hedging is the middle path —
  start the second mirror only if the first has not answered within a few
  seconds — and it keeps the latency win in every case except a first mirror
  that is already down.
- **Overpass and Nominatim are volunteer-run.** They are called only when the
  user explicitly adds a city, and are deliberately never cached by the service
  worker. Don't add background refresh, prefetching, or retry loops beyond the
  existing mirror fallback.
- Map data is OSM, ODbL. Attribution stays in the README. Don't reproduce
  official operator schematic maps — those are copyrighted, which is the whole
  reason this renders its own geometry.

## Layout

```
index.html              app shell, nothing but a mount point
build.ts                the whole build: bun build + a watch server
src/main.ts             mounts App
src/App.svelte          composes the chrome and owns city loading
src/ui/*.svelte         TopBar, MapStage, EmptyState, TripDock, 4 sheets
src/styles.css          chrome is deliberately grey; colour comes from OSM tags
src/lib/types.ts        every shape that crosses a module boundary
src/lib/data.ts         geocode -> Overpass -> station merging -> graph -> IndexedDB
src/lib/graph.ts        Dijkstra over (station, line) states; leg collapsing
src/lib/mapview.ts      SVG render, pan/pinch, culling, label placement
src/lib/state.svelte.ts the whole of the shared state, which is four fields
src/lib/worker-client.ts talking to the builder, and when not to
src/lib/builder.worker.ts fetch -> parse -> buildCity -> save, off the main thread
src/sw.ts               precaches the shell, sequentially, tolerating misses
tests/network.test.ts   bun test; no browser, no network
```

## Toolchain

Bun is package manager, bundler and test runner. TypeScript 7 (the native
compiler) type-checks, oxlint lints, oxfmt formats, Svelte 5 with runes renders
the chrome. `bun run dev` builds and serves on :8080 with `Cache-Control:
no-store`, which exists because Chrome heuristically caches ES modules and an
edit then silently does nothing with no error to explain why.

**The build emits no content hashes, deliberately.** Hashed filenames force the
service worker to be generated, and `src/sw.ts` is hand-written to cache
sequentially — `cache.addAll()` rejects the entire install if one request fails.
Stable names keep that file and its `SHELL` list honest. `CACHE` stays the
update mechanism, so bump it when a shell file changes.

**Svelte owns the chrome; MapView owns the map.** `mapview.ts` is imperative and
sits behind a ref, never inside a component. It is the only hot path — Tokyo
goes 60 ms to 11 ms an interaction on culling, change-only writes and one CSS
custom property, and none of that survives a diff over 4,300 SVG nodes a frame.

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

**$state must be snapshotted before it crosses to a worker.** Svelte wraps
reactive values in Proxies and `postMessage` clones structurally, so handing a
reactive object to the builder throws `DataCloneError: could not be cloned`.
`$state.snapshot()`at the thread boundary is the fix, and it is the one real
trap in the whole migration. Two smaller ones cost time too: the service worker
must be built as a classic script rather than ESM (registering an ESM bundle
fails with only "an unknown error occurred when fetching the script"), and
registering it from`onMount`needs a`document.readyState`check, because
onMount can run after`load` has already fired and the listener then never runs.

**The query asks only for what fits in the box.** `.r out body geom` returns
every member way of every matching relation in full, so Moscow with suburban
rail was a 223 MB download of which 89% was thrown away on arrival. The query
now fetches relations without geometry, then the member ways and nodes bounded
to the same box, and `buildCity` joins the ways back by ref. Measured live:
223.0 MB -> 39.9 MB, 41.1 s -> 7.6 s to fetch, and `buildCity` 6.85 s -> 0.37 s,
for an identical 975-station map. The build got 18x faster for the same reason
the download shrank — most of what chaining and simplification used to process
was destined to be clipped away.

Small cities pay about 11% more, since each way now arrives as its own element
rather than inline. Lisbon builds an identical map either way. `buildCity`
accepts both response shapes, so the old fixtures still work and the query could
be reverted without touching the parser.

**The network is clipped to the bounding box that was asked for.** Overpass
selects a relation if _any_ member falls in the box and `out geom` then returns
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

**Labels are placed, not just thinned.** Each one reserves the width it really
occupies — measured once on a canvas at render — and is tried in four positions
(right, left, above, below) against an occupancy grid, strongest station first,
with interchange dots reserved before any type. Verified by intersecting every
drawn box: zero overlapping pairs on Tokyo and Paris, at 11.4 ms and 8.8 ms per
interaction.

Three constants earned their values the hard way and should not be nudged
without re-measuring:

- **Attempts are rationed per patch of map (3 per 56 px), not globally.** A
  global cap starves the outskirts: candidates are tried strongest first and the
  strongest are all downtown, so the quota goes on losing fights in the centre.
- **Rejection is probed sparsely** — every third column before the full box —
  because most candidates fail and failure is the common path.
- **Cells are 8 px, and the right size depends on the language.** Paris station
  names average 77 px where Tokyo's average 33, because Japanese says it in 3.3
  characters and French takes 15.8. At 4 px cells a Paris label spanned 19
  columns and placement cost 90 ms; 8 px spans 10 and rounds outward by under
  half a character. If labels start colliding, suspect this before the algorithm.

Positions are written by `mapview`, not CSS, since every label now sits
somewhere different — but only when the zoom changes, so panning still writes
nothing.

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

- `bun test` — 40 tests covering station merging and line attribution,
  out-of-station walking interchanges, way chaining into continuous polylines,
  geometry simplification and packing, record migration without a network,
  clipping to the requested box, ways arriving separately from their relation,
  place identity by OSM id, and believing an empty answer only when every
  mirror agrees. All passing.
- `bun run check` is clean: TypeScript 7 `--noEmit` across the 10 modules in
  `src/`, then svelte-check over the 9 components — 0 errors, 0 warnings.
  `oxlint --deny-warnings` is clean as well.
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

|               | stations | points    | store    | per interaction | heap   |
| ------------- | -------- | --------- | -------- | --------------- | ------ |
| Lisbon before | 173      | 8,731     | 0.3 MB   | 3.8 ms          | 4 MB   |
| Lisbon after  | 173      | 868       | ~0.1 MB  | 3.9 ms          | 15 MB  |
| London before | 1,319    | 963,098   | 23.6 MB  | 22.1 ms         | 104 MB |
| London after  | 916      | 50,142    | 0.4 MB   | 7.3 ms          | 16 MB  |
| Moscow before | 2,402    | 5,450,962 | 132.5 MB | 60.0 ms         | 945 MB |
| Moscow after  | 975      | 104,519   | 0.8 MB   | 8.6 ms          | 16 MB  |

And the densest networks, all after:

|          | stations | labels drawn | per interaction | worst   | pan    |
| -------- | -------- | ------------ | --------------- | ------- | ------ |
| Tokyo    | 1,443    | 238          | 10.9 ms         | 13.9 ms | 0.7 ms |
| Paris    | 972      | 151          | 7.8 ms          | 9.1 ms  | 0.4 ms |
| New York | 681      | 128          | 5.4 ms          | 7.8 ms  | 0.3 ms |
| Seoul    | 572      | 117          | 5.5 ms          | 7.4 ms  | 0.3 ms |

Tokyo is the worst case in the world for this app and it sits inside the 16.7 ms
frame budget with its worst frame, not just its median. Seven cities together
occupy 13.7 MB. Routing was checked by hand on each: Seoul reaches Gimpo via
line 2, line 1, AREX and the Goldline; Paris runs M12 to RER C to RER B; New
York goes 5 then 6. They are correct journeys, not merely paths.

**How to measure this, because it is easy to get wrong.** Figures are medians
over 12–14 events with `requestAnimationFrame` held synchronous for the _whole_
run, city loads included. Two traps cost real time here: a background tab pauses
rAF, so the deferred pass never runs and every label stays on screen — the tell
is `labelsShown` equalling `labelsTotal`; and calling `getBBox()` inside the
timing loop forces a layout the wheel event just dirtied, which inflated Paris
from 7.8 ms to 94.7 ms. Measure the handler, and check `labelsShown` first.

**Not verified — start here:**

- **Nothing checks that the seven `querySelector('#…')` calls in `mapview.ts`
  still match the markup in `MapStage.svelte`.** This entry used to claim
  `app.js` was checked against `index.html`; `app.js` has not existed since the
  Svelte migration, and no script in the repo does the equivalent now. Each
  lookup ends in `!`, which is exactly the assertion that stops tsc caring, and
  svelte-check does not read an imperative `.ts` file against another file's
  markup. All seven ids — `#viewport` and the six `#layer-*` groups — are
  present as of this commit, confirmed by hand. Renaming one in the markup is a
  null dereference at first render, with nothing failing earlier to point at it.

- Benchmarks are only trustworthy for the _first_ city measured after a page
  load. Whichever city is measured second reads 5–8x slower — Tokyo-first was
  13.8 ms with Paris-second at 82.6 ms, then Paris-first was 8.8 ms with
  Tokyo-second at 73.9 ms. It is the teardown of the previous city's several
  thousand SVG nodes, not the city being measured. Reload between cities.
- Pinch-zoom is written against Pointer Events but untested on iOS Safari.
- Storage persistence on iOS is asserted from documented behaviour, not
  observed. Much less likely to bite now that a big city is under 1 MB.
- The first zoom after opening a large city costs ~35–45 ms for two or three
  frames — the first cull, plus GC from the build. It settles immediately and
  is well below the threshold of the rest of the work, but it is real.
- The worker is now belt and braces rather than load-bearing. Bounding the
  query cut Moscow's blocking work from ~12.7 s to roughly a second, so the
  freeze it was built to hide has largely gone. It still keeps that second off
  the UI thread and still carries migrations, so it earns its place — but do not
  assume the old numbers when judging changes to it.
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
- The mirror list was surveyed on 2026-08-29 and there is no third healthy
  instance to be had. `kumi.systems` answers 502 and resolves to
  `overpass.private.coffee` — the same 193.219.97.30 — which times out;
  `overpass.osm.jp` presents an expired TLS certificate, which a browser cannot
  be talked past; `overpass.nchc.org.tw` no longer resolves. Of the seven global
  instances the wiki lists, four want an API key or payment. That left
  `maps.mail.ru` as the only keyless global instance still answering, and it
  agreed with `overpass-api.de` exactly on the three reference cities — Lisbon
  8, Prague 6, Moscow 32 subway relations — with `Access-Control-Allow-Origin`
  and a data timestamp a minute apart. It is last in the list so it is reached
  only after both others have failed.
- What `overpass-api.de` does to a request that it will not serve is not
  settled. It has been seen answering 200, 406, 429, 504 and refusing the TCP
  connection outright, sometimes within the same minute, and some of those
  responses carry no CORS headers, so the browser reports a CORS error and the
  real status never reaches the app. A deployed origin failing while localhost
  succeeded looked like origin discrimination and was not reproducible: repeated
  A/B runs flipped both ways within minutes. Do not conclude anything about that
  service from a single pair of requests — interleave repeated trials, and
  expect probing to make it worse, because it escalates per IP.
- Service worker registration could not be confirmed in the test browser: even
  a two-line worker fails there with "an unknown error occurred when fetching
  the script", on two different servers, so it is the environment rather than
  the code. The bundle is a valid classic script served as text/javascript.
  Check it on a real browser before trusting offline mode.

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
bun install
bun run dev      # build + serve on :8080, watching
bun test         # 40 tests, no browser
bun run check    # tsc --noEmit + svelte-check
bun run lint     # oxlint
bun run fmt      # oxfmt
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
previous cache. It is `offline-rails-v1` as of the Svelte migration.

Good first cities to test with: Lisbon or Prague (small, well mapped, fast
query). Tokyo works but the query is heavy and needs suburban rail enabled to
be useful. Some Latin American and African networks tag platforms but not stop
positions — the parser falls back, but stop ordering gets rough. That fallback
path needs real-world testing.

## Next up, in order

1. **Labels still cross lines.** Label-to-label and label-to-interchange
   collisions are solved and measured; track geometry is not an obstacle,
   because testing a text box against 669 polylines per placement is a different
   order of problem. The dark halo under the type (`paint-order: stroke`) is
   what makes it legible in the meantime, so do not remove it. If this is worth
   solving, rasterise the lines once per reflow into the same occupancy grid
   rather than testing geometry per candidate.
2. **Re-run the performance numbers on the Svelte build.** Every figure in this
   file was measured before the migration. The renderer is byte-for-byte the
   same algorithm and should behave identically, but nobody has confirmed it.
3. **Update rather than re-download.** Re-run the query for a saved city and
   diff, so a refresh does not cost a full download. Much more attractive now
   that a refresh is 40 MB rather than 223 MB.
4. **Update rather than re-download.** Re-run the query for a saved city and
   diff, so a refresh doesn't cost a full download.
5. **Export/import a city pack** as JSON, so a travel companion can load a
   network without hitting Overpass at all. Also makes fixture capture easy.
6. **GTFS import** for real timetables, as an optional per-city pack so the
   base download stays small. Only for cities that publish feeds.
7. **Octilinear rendering.** The ambitious one. Snap edges to 45° increments
   with a local search pass while keeping stations near true positions.

## Style notes

Comments in this codebase explain _why_, not what — keep that. UI copy is
sentence case, active voice, and never apologises; errors say what happened and
what to do about it ("No rail lines are mapped here for the modes you picked.
Try adding tram or suburban rail."). The interface has exactly one accent
colour, a sodium yellow, used only for cached/lit states; everything else grey
so the operators' line colours carry the diagram. Don't add a second accent.
