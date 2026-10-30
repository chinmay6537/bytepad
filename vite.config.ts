import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Cross-origin isolation is what makes SharedArrayBuffer, and so blocking
// stdin, available. Only the dev server sends these headers. Production gets
// them from public/sw.js, and `vite preview` deliberately sends none so the
// browser tests exercise exactly what GitHub Pages serves.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Lists built assets so the service worker can cache them all for offline use.
// Monaco emits CSS, HTML and JSON workers too, but this app never starts them.
const precacheManifest = () => ({
  name: 'bytepad-precache-manifest',
  apply: 'build' as const,
  closeBundle() {
    const assets = readdirSync('dist/assets')
      .filter((file) => !/^(css|html|json)\.worker-/.test(file))
      .map((file) => `assets/${file}`);
    writeFileSync(join('dist', 'precache.json'), JSON.stringify(['./', ...assets, 'icon.svg', 'manifest.webmanifest']));
  },
});

export default defineConfig({
  plugins: [precacheManifest()],
  // Relative base so the build works on any host or GitHub Pages subpath, forks included.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 8000 },
  worker: { format: 'es' },
  server: { headers: isolationHeaders },
  // Without this, preview silently inherits the dev server's headers.
  preview: { headers: {} },
  test: { include: ['tests/**/*.test.ts'] },
});
