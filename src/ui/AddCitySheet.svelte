<script lang="ts">
  import { buildCity, emptyNetworkMessage, fetchNetwork, geocode, store } from '../lib/data.ts';
  import { runInWorker } from '../lib/worker-client.ts';
  import type { BuildJob, City, Place, StepName, StepState } from '../lib/types.ts';

  let { open, onloaded, onclose }: {
    open: boolean;
    onloaded: (c: City) => void;
    onclose: () => void;
  } = $props();

  let dlg: HTMLDialogElement;
  let input: HTMLInputElement | undefined = $state.raw();

  let query = $state('');
  let places = $state<Place[]>([]);
  let searching = $state(false);
  let searchNote = $state('');
  let fetching = $state(false);
  let message = $state('');

  const MODES = [
    { value: 'subway', label: 'Metro', on: true },
    { value: 'light_rail', label: 'Light rail', on: true },
    { value: 'tram', label: 'Tram', on: false },
    { value: 'monorail', label: 'Monorail', on: false },
    { value: 'train', label: 'Suburban rail', on: false },
  ];
  let modes = $state(Object.fromEntries(MODES.map((m) => [m.value, m.on])) as Record<string, boolean>);

  const STEPS: { key: StepName; label: string }[] = [
    { key: 'geo', label: 'Locating the city' },
    { key: 'query', label: 'Asking OpenStreetMap for the network' },
    { key: 'build', label: 'Building the map and route graph' },
    { key: 'save', label: 'Saving to this device' },
  ];
  let steps = $state<Record<StepName, StepState>>({
    geo: null,
    query: null,
    build: null,
    save: null,
  });
  const setStep = (name: StepName, state: StepState) => (steps[name] = state);

  $effect(() => {
    if (open && !dlg.open) {
      query = '';
      places = [];
      searchNote = '';
      message = '';
      fetching = false;
      steps = { geo: null, query: null, build: null, save: null };
      dlg.showModal();
      setTimeout(() => input?.focus(), 50);
    }
    if (!open && dlg.open) dlg.close();
  });

  // Nominatim can return the same label twice. Show how big each one is, but
  // only for the rows that actually collide — otherwise it is noise.
  const ambiguous = $derived(
    new Set(
      places
        .map((p) => p.name)
        .filter((n, i, all) => all.indexOf(n) !== i),
    ),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  function onInput(value: string) {
    query = value;
    clearTimeout(timer);
    if (value.trim().length < 3) return;
    timer = setTimeout(() => void runGeocode(value.trim()), 400);
  }

  async function runGeocode(q: string) {
    searching = true;
    searchNote = 'Searching…';
    try {
      places = await geocode(q);
      searchNote = places.length ? '' : 'No place by that name.';
    } catch (err) {
      places = [];
      searchNote = (err as Error).message;
    } finally {
      searching = false;
    }
  }

  async function download(place: Place) {
    const picked = Object.keys(modes).filter((m) => modes[m]);
    if (!picked.length) {
      message = 'Pick at least one kind of line.';
      return;
    }

    places = [];
    fetching = true;
    message = 'Large networks can take a minute. Keep this open.';
    steps = { geo: 'done', query: null, build: null, save: null };

    // $state wraps its contents in Proxies, and postMessage clones structurally
    // — a Proxy throws DataCloneError. Snapshot back to plain data before the
    // job crosses into the worker. This is the one real trap in moving reactive
    // state to a thread boundary.
    const job: BuildJob = $state.snapshot({
      id: `${place.short}-${place.lat.toFixed(2)}-${place.lon.toFixed(2)}`,
      name: place.short,
      bbox: place.bbox,
      modes: picked,
    }) as BuildJob;

    try {
      // Off the main thread where the browser allows it, so the progress ticks
      // keep animating instead of freezing mid-download.
      const off = await runInWorker(job, setStep, (t) => (message = t));
      if (off?.error) throw new Error(off.error);

      let built: City | undefined;
      if (off) {
        built = await store.getCity(job.id);
      } else {
        setStep('query', 'active');
        const raw = await fetchNetwork(job.bbox, job.modes, (t) => (message = t));
        setStep('query', 'done');
        setStep('build', 'active');
        message = `${raw.elements.length.toLocaleString()} map objects received.`;
        await new Promise((r) => setTimeout(r, 30));
        built = buildCity(raw, job);
        if (!built.stations.length) throw new Error(emptyNetworkMessage(raw));
        setStep('build', 'done');
        setStep('save', 'active');
        await store.saveCity(built);
        setStep('save', 'done');
      }

      if (!built) throw new Error('The city was built but could not be read back.');
      message = `Saved ${built.stats.stations} stations across ${built.stats.lines} lines. This works offline now.`;
      const ready = built;
      setTimeout(() => onloaded(ready), 900);
    } catch (err) {
      for (const k of Object.keys(steps) as StepName[]) {
        if (steps[k] === 'active') steps[k] = null;
      }
      message = (err as Error).message;
      fetching = false;
    }
  }
</script>

<dialog id="dlg-add" class="sheet" bind:this={dlg} onclose={onclose}>
  <div class="sheet-head">
    <input
      id="place-input"
      type="search"
      placeholder="City name, e.g. Lisbon"
      autocomplete="off"
      enterkeyhint="search"
      bind:this={input}
      value={query}
      oninput={(e) => onInput(e.currentTarget.value)}
      onkeydown={(e) => e.key === 'Enter' && e.preventDefault()}
    />
    <button id="add-close" class="sheet-close" aria-label="Cancel" onclick={onclose}>Cancel</button>
  </div>

  {#if !fetching}
    <div class="modes" id="mode-picker">
      {#each MODES as m (m.value)}
        <label>
          <input type="checkbox" value={m.value} bind:checked={modes[m.value]} />
          {m.label}
        </label>
      {/each}
    </div>
  {/if}

  <ul id="place-results" class="list">
    {#if searching}
      <li><p class="note" style="padding:14px">Searching…</p></li>
    {:else if searchNote}
      <li><p class="note" style="padding:14px">{searchNote}</p></li>
    {:else}
      {#each places as p (p.id)}
        <li>
          <button class="row" onclick={() => download(p)}>
            <span class="row-main">
              <span>{p.short}</span>
              <span class="row-sub">
                {p.name.split(',').slice(1, 3).join(',').trim()}{ambiguous.has(p.name)
                  ? ` · about ${p.spanKm} km across`
                  : ''}
              </span>
            </span>
          </button>
        </li>
      {/each}
    {/if}
  </ul>

  {#if fetching}
    <div id="fetch-status" class="fetch-status">
      {#each STEPS as s (s.key)}
        <div class="fetch-line" class:active={steps[s.key] === 'active'} class:done={steps[s.key] === 'done'}>
          <span class="tick" data-step={s.key}></span>
          {s.label}
        </div>
      {/each}
      <p id="fetch-msg" class="note">{message}</p>
    </div>
  {:else if message}
    <p id="fetch-msg" class="note" style="padding:0 18px 16px">{message}</p>
  {/if}
</dialog>
