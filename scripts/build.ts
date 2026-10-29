import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/web', { recursive: true });
await build({
  entryPoints: ['web/main.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2022'],
  outdir: 'dist/web',
  entryNames: 'app',
});
await cp('web/index.html', 'dist/web/index.html');
await Promise.all([
  build({ entryPoints: ['application/integrations/opencode-entry.ts'], bundle: true, minify: true,
    sourcemap: true, format: 'esm', platform: 'node', target: ['node24'],
    outfile: 'integrations/opencode-work-hub/dist/index.js' }),
  build({ entryPoints: ['application/integrations/dim-host-entry.ts'], bundle: true, minify: true,
    sourcemap: true, format: 'esm', platform: 'node', target: ['node24'],
    outfile: 'integrations/dim-host-plugin-work-hub/dist/index.js' }),
]);
