# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun run dev            # build + serve on :8080, watching src/
bun run build          # -> dist/
bun test               # 47 tests, no browser, no network
bun test -t "a real corner survives"   # single test by name
bun test tests/network.test.ts         # single file
bun run check          # TypeScript 7 on .ts, then svelte-check on .svelte
bun run lint           # oxlint --deny-warnings
bun run fmt            # oxfmt (fmt:check in CI)
```

CI runs lint → fmt:check → check → test → build, and only deploys from `main`
after all five pass. The gates live in `ci.yml`, which `deploy.yml` calls
through `workflow_call`; `deploy.yml` then ships the `dist` artifact `ci.yml`
built, so what deploys is the tree the gates ran against rather than a second
build of the same commit.

`ci.yml` classifies each push as `full` or `docs` and exports it as an output.
A push touching only `*.md`, `.githooks/`, `LICENSE` or `.gitignore` runs
`fmt:check` alone — oxfmt formats markdown, so that gate can genuinely fail on
one, and it is the only gate those paths can affect — and allocates no deploy
runner. Adding a path to that list means checking what oxfmt claims: it formats
`.json`, `.md`, `.ts` and `.yml`, and ignores `.svelte` and shell.

**Two TypeScript installs, deliberately.** `@typescript/native` is 7.0.2 and does
all the checking; `typescript` is 6.0.3 and exists only because svelte-check's
language-service layer refuses to start without it. The `check` script names the
compiler by path because both packages ship a `tsc` binary and a bare `tsc`
resolves to whichever last wrote `node_modules/.bin` — a reinstall could
silently downgrade the checker. Don't "simplify" it back to `tsc`.

## Architecture

An offline-first PWA. Online exactly once per city: Nominatim geocodes, Overpass
returns the rail relations, and the result is folded into stations + lines + a
routing graph and stored in IndexedDB. Nothing on the critical path touches the
network afterwards.

**Svelte owns the chrome; `MapView` owns the map.** `src/ui/*.svelte` and
`App.svelte` are ordinary components over a small `$state` object
(`lib/state.svelte.ts`: a city, two trip ends, the trip, online-ness).
`lib/mapview.ts` is imperative, ~500 lines, and sits behind a ref in
`MapStage.svelte` — it creates and mutates every node under `#viewport` itself.
This is not stylistic: it is the only hot path, and culling, change-only writes
and a single CSS custom property are what take Tokyo from 60 ms to 11 ms an
interaction. A component diffing 4,300 SVG nodes a frame undoes all of it.

**The build pipeline** (`data.ts`, in `buildCity`): merge stops into stations by
normalised name and distance → `chainShapes` joins relation ways on shared
endpoints → `clipShapes` trims to the requested bbox → Douglas-Peucker at 10 m →
pack to `Int32Array`. Each step exists because of a measured failure; see
HANDOVER.md before changing any of them.

**Stored geometry is packed and render-only.** `line.shapes` is a flat
`Int32Array` of `round(degrees * 1e6)`, interleaved `[lat, lon, …]`. Nothing
routes off it — `graph.ts` walks `graph.adj`, built from station ids — so
changing geometry cannot change an itinerary. Touching the encoding means
touching `data.ts`, `mapview.ts` (which reads the array in place) and the tests
together.

**Routing state is `(station, line)`, not `station`** (`graph.ts`), so a
transfer penalty can be charged when the line changes. A station-keyed Dijkstra
produces absurd six-change itineraries.

**City records are versioned.** `format: 2`, with `needsMigration` /
`migrateCity`. Migration is awaited before render in `App.loadCity`, not fired
and forgotten, because the renderer cannot draw an unconverted record at all.

**Building runs in a worker, with an inline fallback.** `builder.worker.ts` does
fetch → parse → build → save and writes to IndexedDB itself, posting back only
stats. `worker-client.ts` returns `null` when the worker is unavailable, and the
caller then does the same work inline — so the build sequence exists at two call
sites (`AddCitySheet.download` and the worker) and they must stay in step.

## Things that will bite you

- **`$state` must be `$state.snapshot()`-ed before `postMessage`.** Svelte wraps
  reactive values in Proxies; structured clone throws `DataCloneError` on a Proxy.
- **The dev server sends `Cache-Control: no-store` on purpose.** Chrome
  heuristically caches ES modules when a server sends only `Last-Modified`, and
  an edit then silently does nothing with no error to explain why. This cost
  three debugging cycles. If a fix works under `bun test` but not in the browser,
  check `performance.getEntriesByType('resource')` sizes before believing anything.
- **The build emits no content hashes.** Hashed names would force the service
  worker to be generated, and `src/sw.ts` is hand-written to cache _sequentially_
  because `cache.addAll()` rejects the whole install if one request fails. Bump
  `CACHE` in `sw.ts` when a shell file changes, and add new assets to `SHELL`.
- **Some oxlint rules are off for cause, not convenience.** `no-await-in-loop`
  (the Overpass mirror walk is sequential on purpose — parallelising hits three
  volunteer servers at once) and `require-post-message-target-origin`
  (`Worker.postMessage` takes `(message, transfer?)`; obeying the rule throws
  `TypeError`). Verify before re-enabling either.
- **Benchmarks are only trustworthy for the first city measured after a page
  load.** Whichever city is measured second reads 5–8× slower — it is the
  teardown of the previous city's thousands of SVG nodes, not the city being
  measured. Reload between cities.
- **Overpass mirrors disagree.** One can answer `200` with zero elements while
  another returns the full network for the identical query. `fetchNetwork`
  treats an empty response as a mirror failure; `emptyNetworkMessage` refuses to
  blame the map when every mirror comes back empty. Expect rate-limiting when
  testing repeatedly — it is per IP and clears in a minute or two.

## Conventions

**Commits are atomic.** One change per commit, each leaving the tree green. When
work spans several concerns — a parser change and the query change that needed
it — land them separately so either can be reverted alone. Verify before
committing, not after: `bun run lint && bun run check && bun test && bun run build`.

**Commit messages use Conventional Commits**: `type(scope): subject`.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`. Use `perf` when the justification is a measurement — much of this
  repo's history is performance work and it should be findable as such.
- Scopes follow the layout: `data`, `graph`, `mapview`, `ui`, `worker`, `sw`,
  `build`, `ci`, `deps`. Omit the scope when a change genuinely spans the app.
- Subject in the imperative, lowercase after the colon, no trailing period, and
  the whole line under 72 characters.
- Breaking changes take a `!` before the colon (`feat(data)!: …`) and a
  `BREAKING CHANGE:` footer saying what a caller must now do differently.
  Changing the stored record shape is the case that will come up here.
- Blank line, then a body wrapped at ~76 characters.

The body still carries the weight, and this part is not negotiable just because
the subject line now has a prefix:

- Explain **why**, with the numbers that justified it — _"223.0 MB -> 39.9 MB,
  41.1 s -> 7.6 s"_ — and say what was verified and how. The subject says what
  changed; the diff shows how.
- When a change was prompted by a bug, say what the bug actually was, not just
  that one was fixed. Future readers need the failure mode.

Commits before this convention was adopted use plain sentence-case subjects.
They stay as they are — the history is pushed, and rewriting it would cost more
than the consistency is worth.

Work goes straight to `main`; CI gates the deploy. There is no branch/PR ritual
for this repo.

**Formatting and linting are not negotiable by hand.** oxfmt owns style (single
quotes, 100 columns, semicolons, trailing commas, sorted imports) — run
`bun run fmt`, don't hand-format. oxlint runs with `--deny-warnings`, so a new
warning fails the build; fix it or turn the rule off _with a recorded reason_,
as the existing exceptions are.

**Naming.** Components are `PascalCase.svelte`; library modules are lowercase,
hyphenated when they need more than one word (`worker-client.ts`), with Svelte's
own suffixes where they apply (`state.svelte.ts`, `builder.worker.ts`).

**Tests** are grouped by behaviour with `describe`, and both the group and the
test read as English sentences — `describe('old records migrate without a
network')`, `test('a real corner survives')`. A test that exists because
something broke should carry a comment saying what broke; several already do.

## Product constraints

These are the reason the project exists — it replaces an app that went from a
good offline tool to seven IAP tiers and third-party ad tracking.

- **No accounts, subscriptions, analytics, ads or telemetry**, and no dependency
  that adds any.
- **`dist/` stays a plain static folder.** There is a bundler now, but no server,
  no runtime, no edge functions. Cloudflare Pages serves it as-is.
- **Overpass and Nominatim are volunteer-run.** Called only when the user
  explicitly adds a city, never cached by the service worker. No background
  refresh, prefetching, or retry loops beyond the existing mirror fallback.
- **Map data is OSM/ODbL** — attribution stays in the README. Don't reproduce
  official operator schematic maps; rendering our own geometry is the whole
  reason for the projection code.
- **One accent colour**, a sodium yellow, used only for cached/lit states.
  Everything else is grey so the operators' line colours carry the diagram.
- **UI copy is sentence case, active voice, and never apologises.** Errors say
  what happened and what to do about it.

Comments explain _why_, not what. HANDOVER.md carries the measured reasoning
behind the decisions above and the current state of what is and isn't verified —
read it before changing anything in `data.ts` or `mapview.ts`.
