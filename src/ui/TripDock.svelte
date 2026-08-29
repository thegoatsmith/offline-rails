<script lang="ts">
  import { app, clearTrip, mins, setSlot } from '../lib/state.svelte.ts';

  let { onpick }: { onpick: (which: 'from' | 'to') => void } = $props();

  const legColour = (c: string | null | undefined) => c || '#8b939e';
</script>

<section id="dock" class="dock">
  <div class="slots">
    <div class="slot">
      <span class="slot-dot from"></span>
      <button class="field-btn" id="slot-from" onclick={() => onpick('from')}>
        {app.from ? app.from.name : 'Choose start'}
      </button>
      <button class="row-del" aria-label="Clear start" onclick={() => setSlot('from', null)}>×</button>
    </div>
    <div class="slot">
      <span class="slot-dot to"></span>
      <button class="field-btn" id="slot-to" onclick={() => onpick('to')}>
        {app.to ? app.to.name : 'Choose destination'}
      </button>
      <button class="row-del" aria-label="Clear destination" onclick={() => setSlot('to', null)}>
        ×
      </button>
    </div>
  </div>

  <div id="trip" class="trip">
    {#if app.from && app.to && !app.trip}
      <p class="trip-fail">
        No connected path between these two in the cached network. They may be on separate systems,
        or a link is missing from OpenStreetMap here.
      </p>
    {:else if app.trip}
      {@const r = app.trip}
      <div class="trip-head">
        <strong>{mins(r.seconds)}</strong>
        <span>
          {r.changes === 0 ? 'direct' : `${r.changes} ${r.changes === 1 ? 'change' : 'changes'}`}
        </span>
        <span>estimated</span>
      </div>

      {#each r.legs as leg, i (i)}
        {@const hops = leg.stations.length - 1}
        <div class="leg" class:walk={leg.walk} style="--leg-colour: {legColour(leg.colour)}">
          <div class="spine"><span class="node start"></span><span class="node end"></span></div>
          <div class="leg-body">
            <div class="leg-station">{leg.stations[0]?.name}</div>
            {#if leg.walk}
              <div class="leg-note">Walk about {leg.metres} m · {mins(leg.seconds)}</div>
            {:else}
              <div class="leg-line">
                <span class="bullet">{leg.ref || '·'}</span>{leg.mode || 'rail'}
              </div>
              <div class="leg-stops">
                {hops} stop{hops === 1 ? '' : 's'} · {mins(leg.seconds)}
              </div>
            {/if}
            <div class="leg-station terminal">{leg.stations[leg.stations.length - 1]?.name}</div>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</section>
