<script lang="ts">
  import { app } from '../lib/state.svelte.ts';

  let { oncities, onlocate }: { oncities: () => void; onlocate: () => void } = $props();
</script>

<header class="bar">
  <button id="btn-cities" class="bar-btn" aria-label="Saved cities" onclick={oncities}>
    <span class="glyph-stack" aria-hidden="true"></span>
  </button>
  <div class="bar-title">
    <span id="city-name">{app.city ? app.city.name : 'No city loaded'}</span>
    <span id="net-state" class="net-state" data-state={app.online ? 'online' : 'offline'}>
      {app.online ? 'connected' : 'offline · cached'}
    </span>
  </div>
  <button id="btn-locate" class="bar-btn" aria-label="Find nearest station" onclick={onlocate}>
    <span class="glyph-target" aria-hidden="true"></span>
  </button>
</header>
