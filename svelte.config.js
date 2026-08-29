// Only svelte-check reads this. The build goes through bun-plugin-svelte, and
// Svelte 5 strips the types in <script lang="ts"> itself, so there is no
// preprocessor here and no Vite dependency to carry for one config file.
export default {
  compilerOptions: { runes: true },
};
