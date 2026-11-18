import { build } from 'esbuild';
import { readFile, mkdir, stat } from 'node:fs/promises';
const frontend = await build({ entryPoints: ['public/app.js'], bundle: true, minify: true, platform: 'browser', write: false });
const css = await readFile('public/style.css', 'utf8');
const html = (await readFile('public/index.html', 'utf8')).replace('__STYLE__', () => css).replace('__APP__', () => frontend.outputFiles[0].text.replaceAll('</script', '<\\/script'));
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['worker.js'], outfile: 'dist/worker.js', bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', plugins: [{ name: 'inline-page', setup(build) { build.onLoad({ filter: /index\.html$/ }, () => ({ contents: html, loader: 'text' })); } }] });
console.log(`Build complete: dist/worker.js (${(await stat('dist/worker.js')).size} bytes, single ESM bundle)`);
