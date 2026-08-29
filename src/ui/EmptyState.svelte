<script lang="ts">
  let { onadd }: { onadd: () => void } = $props();
</script>

<div id="empty" class="empty">
  <p class="empty-kicker">Nothing cached yet</p>
  <h1 class="empty-head">Add a city while<br />you still have signal.</h1>
  <p class="empty-body">
    Offline Rails pulls the network from OpenStreetMap once, stores it on this device, and never
    needs the internet again.
  </p>
  <button id="btn-add-first" class="btn-primary" onclick={onadd}>Add a city</button>
</div>
