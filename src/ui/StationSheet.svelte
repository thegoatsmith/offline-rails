<script lang="ts">
  import type { Station } from '../lib/types.ts';

  let {
    station,
    onpick,
    onclose,
  }: {
    station: Station | null;
    onpick: (which: 'from' | 'to', s: Station) => void;
    onclose: () => void;
  } = $props();

  let dlg: HTMLDialogElement;
  $effect(() => {
    if (station && !dlg.open) dlg.showModal();
    if (!station && dlg.open) dlg.close();
  });
</script>

<dialog id="dlg-station" class="sheet sheet-short" bind:this={dlg} onclose={onclose}>
  {#if station}
    <div class="sheet-head">
      <div>
        <h2 id="st-name">{station.name}</h2>
        <p id="st-lines" class="st-lines">
          {station.lines.length ? station.lines.map((l) => l.label).join(' · ') : 'no line data'}
        </p>
      </div>
      <button id="st-close" class="sheet-close" aria-label="Close" onclick={onclose}>Done</button>
    </div>
    <div class="sheet-actions">
      <button id="st-from" class="btn-ghost" onclick={() => onpick('from', station!)}>
        Start here
      </button>
      <button id="st-to" class="btn-primary" onclick={() => onpick('to', station!)}>End here</button>
    </div>
  {/if}
</dialog>
