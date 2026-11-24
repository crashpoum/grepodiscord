// Bundles the web app (Activity + dashboard) into compiled/public. Run after tsc (npm run build).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const out = 'compiled/public';
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ['web/src/main.ts'], bundle: true, format: 'esm', target: ['es2022'], minify: true, sourcemap: true,
  outfile: `${out}/app.js`, legalComments: 'none', logLevel: 'warning',
});
copyFileSync('web/index.html', `${out}/index.html`);
copyFileSync('web/app.css', `${out}/app.css`);
console.log('web bundle ->', out);
