<script lang="ts">
  import { app } from '../lib/state.svelte.ts';
  import type { Station } from '../lib/types.ts';

  let {
    open,
    onchoose,
    onclose,
  }: { open: boolean; onchoose: (s: Station) => void; onclose: () => void } = $props();

  let dlg: HTMLDialogElement;
  let input: HTMLInputElement | undefined = $state.raw();
  let term = $state('');

  $effect(() => {
    if (open && !dlg.open) {
      term = '';
      dlg.showModal();
      setTimeout(() => input?.focus(), 50);
    }
    if (!open && dlg.open) dlg.close();
  });

  const rows = $derived.by(() => {
    if (!app.city) return [];
    const q = term.trim().toLowerCase();
    return app.city.stations
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .toSorted((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name))
      .slice(0, 60);
  });
</script>

<dialog id="dlg-search" class="sheet" bind:this={dlg} onclose={onclose}>
  <div class="sheet-head">
    <input
      id="search-input"
      type="search"
      placeholder="Search stations"
      autocomplete="off"
      enterkeyhint="search"
      bind:this={input}
      bind:value={term}
      onkeydown={(e) => e.key === 'Enter' && e.preventDefault()}
    />
    <button id="search-close" class="sheet-close" aria-label="Close" onclick={onclose}>Done</button>
  </div>
  <ul id="search-results" class="list">
    {#if !rows.length}
      <li>
        <p class="note" style="padding:14px">
          No station here matches that. Try a shorter spelling.
        </p>
      </li>
    {:else}
      {#each rows as s (s.id)}
        <li>
          <button class="row" onclick={() => onchoose(s)}>
            <span class="row-main">
              <span>{s.name}</span>
              <span class="row-sub">{s.lines.map((l) => l.label).join(' · ') || '—'}</span>
            </span>
          </button>
        </li>
      {/each}
    {/if}
  </ul>
</dialog>
