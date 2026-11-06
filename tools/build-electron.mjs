import { build } from 'esbuild';
await build({ entryPoints: ['electron/main.ts'], outfile: 'out/main.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'out/preload.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true });
