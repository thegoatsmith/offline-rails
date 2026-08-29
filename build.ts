// build.ts — the whole build. `bun run build`, or `--watch` to serve it.
//
// Deliberately no content hashes in the output names. A bundler that emits
// `index-a1b2c3.js` forces the service worker to be generated too, and the one
// in this repo is hand-written for a reason: `cache.addAll()` rejects the whole
// install if a single request fails, so it caches sequentially and tolerates a
// miss. Stable filenames keep that file, and its `SHELL` list, honest. Cache
// busting stays where it already was — the `CACHE` constant in sw.ts.

import { existsSync } from 'node:fs';
import { rm, mkdir, cp, readdir } from 'node:fs/promises';

import { SveltePlugin } from 'bun-plugin-svelte';

const OUT = 'dist';
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // The page and the worker are separate entrypoints. The worker must land on
  // a predictable path because worker-client.ts asks for it by name and the
  // service worker precaches it.
  const result = await Bun.build({
    entrypoints: ['./src/main.ts', './src/lib/builder.worker.ts'],
    outdir: OUT,
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: !dev,
    sourcemap: dev ? 'linked' : 'none',
    naming: { entry: '[name].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name].[ext]' },
    plugins: [SveltePlugin({ development: dev })],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error('build failed');
  }

  // The service worker is its own bundle: it runs in a different global scope
  // and must not be pulled into the page graph.
  const sw = await Bun.build({
    entrypoints: ['./src/sw.ts'],
    outdir: OUT,
    target: 'browser',
    // A classic script, not a module. Module service workers are still not
    // universally supported, and registering an ESM bundle as a classic script
    // fails with only "an unknown error occurred when fetching the script".
    format: 'iife',
    minify: !dev,
    naming: { entry: '[name].[ext]' },
  });
  if (!sw.success) {
    for (const log of sw.logs) console.error(String(log));
    throw new Error('service worker build failed');
  }

  await Bun.write(`${OUT}/index.html`, await Bun.file('index.html').text());
  if (existsSync('public')) await cp('public', OUT, { recursive: true });

  const files = await readdir(OUT, { recursive: true });
  const total = (
    await Promise.all(
      files.map(async (f) =>
        (await Bun.file(`${OUT}/${f}`).exists()) ? Bun.file(`${OUT}/${f}`).size : 0,
      ),
    )
  ).reduce((a, b) => a + b, 0);
  console.log(
    `built ${files.length} files, ${(total / 1024).toFixed(0)} KB${dev ? ' (dev)' : ''} -> ${OUT}/`,
  );
}

await build();

if (watch) {
  const port = Number(process.env.PORT ?? 8080);
  Bun.serve({
    port,
    development: true,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = Bun.file(OUT + path);
      if (await file.exists()) {
        return new Response(file, {
          // No caching in dev, ever. Chrome heuristically caches ES modules
          // when a server sends only Last-Modified, and then an edit silently
          // does nothing in the browser with no error to explain why.
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return new Response(Bun.file(`${OUT}/index.html`), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
      });
    },
  });
  console.log(`serving http://localhost:${port} — watching for changes`);

  const watcher = (await import('node:fs')).watch(
    'src',
    { recursive: true },
    async (_e, filename) => {
      if (!filename) return;
      try {
        await build();
        console.log(`rebuilt after ${filename}`);
      } catch {
        /* build() already printed why */
      }
    },
  );
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}
