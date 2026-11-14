// Assemble l'interface dans dist/ (esbuild + copie des fichiers statiques).
import { build } from 'esbuild';
import { cp, mkdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = (...parts) => path.join(root, ...parts);
const dist = from('dist');

await rm(dist, { recursive: true, force: true });
await mkdir(from('dist/ort'), { recursive: true });
await mkdir(from('dist/codecs'), { recursive: true });
await mkdir(from('dist/fonts'), { recursive: true });

await build({
  entryPoints: [from('src/app.js'), from('src/codec-worker.js'), from('src/ai-worker.js')],
  outdir: dist,
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: 'chrome130',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
});

await copyFile(from('src/index.html'), from('dist/index.html'));
await copyFile(from('src/styles.css'), from('dist/styles.css'));
await cp(from('src/assets'), from('dist/assets'), { recursive: true });

// ONNX Runtime Web (calcul des modèles IA en WebAssembly multi-cœur).
const ort = from('node_modules/onnxruntime-web/dist');
for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(path.join(ort, file), from('dist/ort', file));
}
await copyFile(from('node_modules/@jsquash/avif/codec/enc/avif_enc.wasm'), from('dist/codecs/avif_enc.wasm'));

const fonts = [
  ['@fontsource/fraunces/files/fraunces-latin-400-normal.woff2', 'fraunces-400.woff2'],
  ['@fontsource/fraunces/files/fraunces-latin-400-italic.woff2', 'fraunces-400-italic.woff2'],
  ['@fontsource/fraunces/files/fraunces-latin-600-normal.woff2', 'fraunces-600.woff2'],
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter.woff2'],
];
for (const [source, name] of fonts) await copyFile(from('node_modules', source), from('dist/fonts', name));
console.log('interface assemblée dans dist/');
