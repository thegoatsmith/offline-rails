<script lang="ts">
  // The one place Svelte hands control back. MapView owns every node inside
  // #viewport and writes to them directly; Svelte only supplies the element and
  // is told when the city or the route changes. Letting a component diff 4,300
  // SVG nodes a frame would undo the culling that makes Tokyo pan at all.
  import { onMount } from 'svelte';
  import { MapView } from '../lib/mapview.ts';
  import { app, plan, setSlot } from '../lib/state.svelte.ts';
  import type { City, RouteResult } from '../lib/types.ts';

  let { onstationtap }: { onstationtap: (id: string) => void } = $props();

  let svgEl: SVGSVGElement;
  let view: MapView | undefined = $state.raw();
  let hintShown = $state(false);

  export function getView(): MapView | undefined {
    return view;
  }

  onMount(() => {
    view = new MapView(svgEl);
    view.onStationTap = (id) => onstationtap(id);

    const onResize = () => app.city && view?.fit();
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  });

  // Render when the city changes identity, not on every state touch.
  let rendered: City | null = null;
  $effect(() => {
    const c = app.city;
    if (!view || !c || c === rendered) return;
    rendered = c;
    view.render(c);
    hintShown = true;
    const t = setTimeout(() => (hintShown = false), 4000);
    return () => clearTimeout(t);
  });

  let drawn: RouteResult | null = null;
  $effect(() => {
    const t = app.trip;
    if (!view || t === drawn) return;
    drawn = t;
    view.showRoute(t);
  });

  export function locate(): void {
    if (!app.city || !view) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        view!.showMe(latitude, longitude);
        const hit = nearestStation(latitude, longitude);
        if (!hit) return;
        view!.centreOn(latitude, longitude, Math.max(view!.k, 0.004));
        setSlot('from', hit);
        plan();
      },
      () => alert('Location is off for this site. GPS still works offline once you allow it.'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  function nearestStation(lat: number, lon: number) {
    if (!app.city) return null;
    let best = null;
    let bestD = Infinity;
    for (const s of app.city.stations) {
      const dLat = (s.lat - lat) * 110574;
      const dLon = (s.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
      const d = Math.hypot(dLat, dLon);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
</script>

<svg id="map" bind:this={svgEl} role="img" aria-label="Metro network diagram">
  <g id="viewport">
    <g id="layer-lines"></g>
    <g id="layer-links"></g>
    <g id="layer-stations"></g>
    <g id="layer-labels"></g>
    <g id="layer-route"></g>
    <g id="layer-me"></g>
  </g>
</svg>

{#if hintShown}
  <div id="zoomhint" class="zoomhint">Pinch to zoom · tap a station to route</div>
{/if}
