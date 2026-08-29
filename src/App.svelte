<script lang="ts">
  import { onMount } from 'svelte';
  import { migrateCity, needsMigration, store } from './lib/data.ts';
  import { app, clearTrip, plan, setSlot } from './lib/state.svelte.ts';
  import { runInWorker } from './lib/worker-client.ts';
  import type { City, Station } from './lib/types.ts';

  import AddCitySheet from './ui/AddCitySheet.svelte';
  import CitiesSheet from './ui/CitiesSheet.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import MapStage from './ui/MapStage.svelte';
  import SearchSheet from './ui/SearchSheet.svelte';
  import StationSheet from './ui/StationSheet.svelte';
  import TopBar from './ui/TopBar.svelte';
  import TripDock from './ui/TripDock.svelte';

  let stage: ReturnType<typeof MapStage> | undefined = $state.raw();

  let showCities = $state(false);
  let showAdd = $state(false);
  let picking = $state<'from' | 'to' | null>(null);
  let tapped = $state<Station | null>(null);
  let compacting = $state('');

  onMount(() => {
    // onMount can run after `load` has already fired, in which case a `load`
    // listener never runs and the worker is silently never registered — which
    // is exactly what happened when this moved out of a top-level module
    // script. Register now if the page is already up, otherwise wait.
    if ('serviceWorker' in navigator) {
      const register = () => {
        navigator.serviceWorker
          .register('/sw.js')
          .catch((err) => console.warn('[offline-rails] service worker did not register', err));
      };
      if (document.readyState === 'complete') register();
      else addEventListener('load', register, { once: true });
    }
    void navigator.storage?.persist?.();

    const net = () => (app.online = navigator.onLine);
    addEventListener('online', net);
    addEventListener('offline', net);

    void (async () => {
      const lastId = await store.getPref<string>('lastCity');
      const cities = await store.allCities();
      const pick = cities.find((c) => c.id === lastId) || cities[0];
      if (pick) await loadCity(pick);
    })();

    return () => {
      removeEventListener('online', net);
      removeEventListener('offline', net);
    };
  });

  async function loadCity(c: City) {
    // Cities saved before the geometry was compacted are converted on first open
    // rather than on a sweep at boot: no network, and you only pay for the cities
    // you actually use. The map cannot be drawn until it finishes, because the
    // renderer reads packed geometry — so this is awaited, not fired and
    // forgotten. A record that fails to convert is left exactly as it was.
    if (needsMigration(c)) {
      compacting = `Compacting ${c.name}…`;
      try {
        const off = await runInWorker({ type: 'migrate', id: c.id });
        if (off && !off.error) c = (await store.getCity(c.id)) || c;
        else if (migrateCity(c)) await store.saveCity(c);
      } catch (err) {
        console.warn('[offline-rails] could not compact', c.id, err);
      }
      compacting = '';
    }

    clearTrip();
    app.city = c;
    showCities = false;
    showAdd = false;
    void store.setPref('lastCity', c.id);
  }

  function onStationTap(id: string) {
    tapped = app.city?.stations.find((s) => s.id === id) ?? null;
  }

  function assign(which: 'from' | 'to', s: Station) {
    setSlot(which, s);
    tapped = null;
  }

  function chooseFromSearch(s: Station) {
    if (picking) setSlot(picking, s);
    picking = null;
  }
</script>

<TopBar oncities={() => (showCities = true)} onlocate={() => stage?.locate()} />

<main id="stage">
  <MapStage bind:this={stage} onstationtap={onStationTap} />
  {#if !app.city}
    <EmptyState onadd={() => (showAdd = true)} />
  {/if}
  {#if compacting}
    <div class="zoomhint">{compacting}</div>
  {/if}
</main>

{#if app.city}
  <TripDock onpick={(which) => (picking = which)} />
{/if}

<SearchSheet
  open={picking !== null}
  onchoose={chooseFromSearch}
  onclose={() => (picking = null)}
/>

<StationSheet station={tapped} onpick={assign} onclose={() => (tapped = null)} />

<CitiesSheet
  open={showCities}
  onopencity={loadCity}
  onadd={() => {
    showCities = false;
    showAdd = true;
  }}
  onclose={() => (showCities = false)}
/>

<AddCitySheet open={showAdd} onloaded={loadCity} onclose={() => (showAdd = false)} />
