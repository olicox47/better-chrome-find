import { build } from 'vite';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const entry of ['background', 'content', 'offscreen', 'matcher-worker', 'action']) {
  await build({
    configFile: false, publicDir: false, logLevel: 'warn',
    build: {
      outDir: 'dist', emptyOutDir: false, target: 'chrome127', sourcemap: true,
      lib: { entry: resolve(`src/${entry}.ts`), name: 'betterChromeFind', formats: ['iife'], fileName: () => `${entry}.js` },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}
for (const file of ['manifest.json', 'offscreen.html', 'action.html']) {
  await copyFile(`public/${file}`, `dist/${file}`);
}
await cp('public/icons', 'dist/icons', { recursive: true });
console.log('Built Better Chrome Find → dist/');
