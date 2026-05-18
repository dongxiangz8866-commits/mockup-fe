// Post-build slimming. Vite copies the whole publicDir into dist/, but the
// deployed routes (/, /displace, /shading) never fetch these:
//   models/        old originals, hidden from the picker since 2026-05-13
//   mock-models/   only referenced by SourceModelViewer, which is dead code
//   sweatshirt.glb Viewer3D asset; Viewer3D is not wired into any route
//
// This deletes them from dist/ ONLY — app/public/ (your originals) is never
// touched. Re-run-safe; runs automatically as the npm `postbuild` step, so
// Netlify/Vercel CI builds come out slim too.

import { rm, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const DROP = ['models', 'mock-models', 'sweatshirt.glb'];

async function dirSize(p) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = resolve(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

const before = await dirSize(DIST);
for (const name of DROP) {
  const target = resolve(DIST, name);
  // Path guard: never escape dist/.
  if (target !== resolve(DIST, name) || !target.startsWith(DIST)) continue;
  await rm(target, { recursive: true, force: true });
  console.log(`[trim-dist] removed dist/${name}`);
}
const after = await dirSize(DIST);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`[trim-dist] dist ${mb(before)}MB → ${mb(after)}MB`);
