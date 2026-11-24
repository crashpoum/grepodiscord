// Bundles the web app (Activity + dashboard) into compiled/public. Run after tsc (npm run build).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const out = 'compiled/public';
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (/^(app|chunk-)/.test(f)) rmSync(`${out}/${f}`);
// Code splitting: the Discord SDK is a separate chunk loaded only inside the Activity.
await build({
  entryPoints: { app: 'web/src/main.ts' }, bundle: true, format: 'esm', splitting: true, target: ['es2022'], minify: true, sourcemap: true,
  outdir: out, chunkNames: 'chunk-[hash]', legalComments: 'none', logLevel: 'warning',
});
copyFileSync('web/index.html', `${out}/index.html`);
copyFileSync('web/app.css', `${out}/app.css`);
const size = (f) => { const b = readFileSync(`${out}/${f}`); return `${f} ${(b.length / 1024).toFixed(1)} KB (${(gzipSync(b, { level: 9 }).length / 1024).toFixed(1)} KB gzip)`; };
console.log('web bundle ->', out);
for (const f of readdirSync(out).filter((f) => /\.(js|css)$/.test(f))) console.log('  ' + size(f));
