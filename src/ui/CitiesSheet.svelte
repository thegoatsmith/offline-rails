<script lang="ts">
  import { store } from '../lib/data.ts';
  import { app, when } from '../lib/state.svelte.ts';
  import type { City } from '../lib/types.ts';

  let {
    open,
    onopencity,
    onadd,
    onclose,
  }: {
    open: boolean;
    onopencity: (c: City) => void;
    onadd: () => void;
    onclose: () => void;
  } = $props();

  let dlg: HTMLDialogElement;
  let cities = $state<City[]>([]);
  let storageNote = $state('');

  async function refresh() {
    cities = await store.allCities();
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    storageNote = est
      ? `Using ${((est.usage ?? 0) / 1e6).toFixed(1)} MB of about ${((est.quota ?? 0) / 1e6).toFixed(0)} MB available. Storage is ${
          persisted
            ? 'marked persistent'
            : 'not yet persistent — install the app to your home screen to protect it'
        }.`
      : '';
  }

  $effect(() => {
    if (open && !dlg.open) {
      void refresh();
      dlg.showModal();
    }
    if (!open && dlg.open) dlg.close();
  });

  async function remove(c: City) {
    await store.deleteCity(c.id);
    if (app.city?.id === c.id) location.reload();
    else await refresh();
  }
</script>

<dialog id="dlg-cities" class="sheet" bind:this={dlg} onclose={onclose}>
  <div class="sheet-head">
    <h2>Saved cities</h2>
    <button id="cities-close" class="sheet-close" aria-label="Close" onclick={onclose}>Done</button>
  </div>

  <ul id="city-list" class="list">
    {#if !cities.length}
      <li><p class="note" style="padding:14px">Nothing saved yet.</p></li>
    {:else}
      {#each cities as c (c.id)}
        <li>
          <div style="display:flex; align-items:center">
            <button class="row" onclick={() => onopencity(c)}>
              <span class="row-main">
                <span>{c.name}</span>
                <span class="row-sub">
                  {c.stats.stations} stations · {c.stats.lines} lines · saved {when(c.savedAt)}
                </span>
              </span>
            </button>
            <button class="row-del" onclick={() => remove(c)}>Remove</button>
          </div>
        </li>
      {/each}
    {/if}
  </ul>

  <div class="sheet-actions">
    <button id="btn-add-city" class="btn-primary" onclick={onadd}>Add a city</button>
    <p id="storage-note" class="note">{storageNote}</p>
  </div>
</dialog>
