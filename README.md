# Offline Rails

An offline metro map you own. Add a city while you have signal; it pulls that
city's rail network from OpenStreetMap, folds it into a map plus a routing
graph, and stores the whole thing on your device. After that it never touches
the network again — no subscription, no per-city unlock, no ads, no tracking.

## Run it

Service workers need a real origin, so open it over HTTP rather than `file://`:

```bash
cd offline-rails
python3 -m http.server 8000 --protocol HTTP/1.1
# then http://localhost:8000
```

Use a threaded or HTTP/1.1 server. Plain `python3 -m http.server` handles one
request at a time, and the service worker's install step requests the whole
shell at once — on a serial server most of those get dropped and the install
fails. `npx serve` works too.

## Put it on your phone

Any static host works — GitHub Pages, Netlify drop, Cloudflare Pages, a folder
on your own server. It's plain files, no build step.

1. Push this folder to a repo, enable GitHub Pages (or drag it onto
   netlify.com/drop).
2. Open the HTTPS URL on your phone. HTTPS is required for the service worker
   and for geolocation.
3. iOS: Share → Add to Home Screen. Android: the install prompt appears on its
   own.

Installing to the home screen matters on iOS: Safari evicts storage from
ordinary sites after about a week of disuse, but installed web apps are
exempt. The app also calls `navigator.storage.persist()` on launch. The Cities
sheet tells you whether storage is actually marked persistent.

## How it works

| File         | Job                                                                              |
| ------------ | -------------------------------------------------------------------------------- |
| `data.js`    | Nominatim geocode → Overpass query → station merging → routing graph → IndexedDB |
| `graph.js`   | Dijkstra over `(station, line)` states so interchanges cost real time            |
| `mapview.js` | SVG rendering, pan and pinch, screen-constant station sizes                      |
| `app.js`     | UI: cities, search, trip strip diagram, geolocation                              |
| `sw.js`      | Precaches the shell. Never caches Overpass or Nominatim                          |

**Station merging.** OSM has one stop node per platform per direction. Stops
sharing a name within 900 m collapse into one station; unnamed ones merge
within 80 m. Distinct stations within 350 m get a walking transfer edge, which
is how out-of-station interchanges like Bank–Monument work.

**Timing.** There are no timetables in this, so times are modelled: distance
over an average speed per mode, 25 s dwell per stop, 45 s plus walking distance
for a foot transfer, and a 4 minute penalty for changing lines. Trip times read
"estimated" because they are. Constants live at the top of `data.js`.

**Colours.** Every colour in the diagram is the operator's own `colour` tag
from OSM. The app's chrome stays grey so it doesn't fight the network.

## What it doesn't do

- No live departures or disruptions. That needs a signal, which is the whole
  point of the thing.
- No timetables, so no "next train at 14:32".
- Coverage is only as good as OSM in that city. Western Europe, Japan and
  Korea are excellent; some networks tag platforms but not stop positions,
  which the parser falls back to but with rougher stop ordering.
- The map is geographic, not a Beck-style schematic. Schematic layout from raw
  geometry is a genuinely hard problem — see LOOM (Bast, Brosi, Storandt) if
  you want to go there. Geographic has one real advantage offline: it matches
  what you see when you surface.

## Next things worth building

1. **GTFS import** for real timetables in cities that publish feeds, stored as
   a separate optional pack per city so the base download stays small.
2. **Octilinear rendering** — snap edges to 45° increments with a local search
   pass, keeping stations near their true positions.
3. **Fare zones** from OSM zone tags, shown as rings.
4. **Update check** — re-run the query and diff, rather than re-downloading.
5. **Share a pack** — export a city as a JSON file so a travel companion can
   import it without hitting Overpass at all.

## Attribution

Map data © OpenStreetMap contributors, ODbL. Geocoding by Nominatim. Both are
volunteer-run: keep queries occasional, and don't point a bulk downloader at
them.
