// Post-build slimming. Vite copies the WHOLE publicDir into dist/, including
// things the picker scanner deliberately skips and routes never fetch. This
// prunes dist/ so the deployed bundle == exactly what the app can serve.
// app/public/ (your originals) is never touched; re-run-safe; runs as the
// npm `postbuild` step so Netlify/Vercel CI builds come out slim too.
//
// Dropped wholesale (unused by /, /displace, /shading):
//   models/        old originals, hidden from the picker since 2026-05-13
//   mock-models/   only referenced by SourceModelViewer, which is dead code
//   sweatshirt.glb Viewer3D asset; Viewer3D is not wired into any route
//
// Pruned inside the picker dirs to mirror vite.config's scanAssetDir rules
// (it skips `_`-prefixed entries and non-image files) — e.g. test-models/
// _rejected/ (~86MB of discarded shots) and the stale MANIFEST.json.

import { rm, stat, readdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Surge reads dist/CNAME for the deploy domain. vite wipes dist on every
// build, so re-stamp it here (postbuild) — keeps `pnpm deploy:surge` a
// single command that always lands on the same URL. Skipped under GitHub
// Actions: there a CNAME file would mis-configure GitHub Pages.
const SURGE_DOMAIN = 'yangji-mockup.surge.sh';
const DROP = ['models', 'mock-models', 'sweatshirt.glb'];
const PICKER_DIRS = ['test-models', 'test-patterns'];
const SERVABLE = /\.(png|jpe?g|webp|svg)$/i;

// Vite bakes VITE_ASSET_CDN into the bundle from .env.production, but this
// node postbuild step doesn't get Vite's env loading — read the same file
// so "set it once in .env.production" stays the single source of truth.
async function cdnEnabled() {
  if (process.env.VITE_ASSET_CDN) return true;
  try {
    const env = await readFile(resolve(DIST, '..', '.env.production'), 'utf8');
    return /^\s*VITE_ASSET_CDN\s*=\s*\S/m.test(env);
  } catch {
    return false;
  }
}
const CDN_ON = await cdnEnabled();

async function dirSize(p) {
  let entries;
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
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

async function dropInside(distDir) {
  const root = resolve(DIST, distDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Mirror scanAssetDir: skip `_`-prefixed, and only image files are
    // ever served — anything else is dead weight in the bundle.
    const keep = !e.name.startsWith('_') && (e.isDirectory() || SERVABLE.test(e.name));
    if (keep) continue;
    const target = resolve(root, e.name);
    if (!target.startsWith(DIST)) continue; // path guard
    await rm(target, { recursive: true, force: true });
    console.log(`[trim-dist] removed dist/${distDir}/${e.name}`);
  }
}

const before = await dirSize(DIST);
for (const name of DROP) {
  const target = resolve(DIST, name);
  if (!target.startsWith(DIST)) continue; // path guard
  await rm(target, { recursive: true, force: true });
  console.log(`[trim-dist] removed dist/${name}`);
}
// With VITE_ASSET_CDN the picker fetches these from the CDN, so the deploy
// origin must not also carry them — drop the dirs whole. Without it, keep
// the in-place prune so a CDN-less deploy still serves the assets.
if (CDN_ON) {
  for (const d of PICKER_DIRS) {
    const target = resolve(DIST, d);
    if (!target.startsWith(DIST)) continue; // path guard
    await rm(target, { recursive: true, force: true });
    console.log(`[trim-dist] removed dist/${d} (served from CDN)`);
  }
} else {
  for (const d of PICKER_DIRS) await dropInside(d);
}
if (!process.env.GITHUB_ACTIONS) {
  await writeFile(resolve(DIST, 'CNAME'), SURGE_DOMAIN);
  console.log(`[trim-dist] wrote dist/CNAME = ${SURGE_DOMAIN}`);
}

const after = await dirSize(DIST);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`[trim-dist] dist ${mb(before)}MB → ${mb(after)}MB`);
