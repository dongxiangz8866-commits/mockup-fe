// One-shot, re-run-safe asset slimming for the picker dirs. The sample
// model photos / patterns shipped as 1–4MB PNGs (photographic content in a
// lossless container); on a CDN-or-not deploy that's the single biggest
// payload. This transcodes them to WebP q82 in place — WebP keeps the
// alpha channel that some test-patterns rely on (a JPEG pass would white-box
// transparent logos), and is ~80% smaller on photo content.
//
// Format only, no resize: the sample shots are already ~960×1280 and feed
// the synthesis pipeline (pose + shading sample them), so downscaling would
// trade real fidelity for marginal bytes.
//
// Scope mirrors vite.config's scanAssetDir: recurse, skip `_`-prefixed
// entries, only touch raster source formats. svg (vector) and existing
// webp are left untouched; the source file is removed only after its
// .webp is written, so an interrupted run just re-converts next time.

import { readdir, stat, rm } from 'node:fs/promises';
import { resolve, dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['public/test-models', 'public/test-patterns'].map((d) => resolve(APP, d));
const SRC = /\.(png|jpe?g)$/i;
const QUALITY = 82;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('_')) continue; // mirror scanAssetDir skip rule
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (SRC.test(e.name)) yield full;
  }
}

async function sizeOf(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

let before = 0;
let after = 0;
let converted = 0;

for (const root of DIRS) {
  for await (const src of walk(root)) {
    const out = join(dirname(src), basename(src, extname(src)) + '.webp');
    const inBytes = await sizeOf(src);
    try {
      // .rotate() bakes EXIF orientation then strips it — AI/phone shots
      // otherwise render sideways once the orientation tag is dropped.
      await sharp(src).rotate().webp({ quality: QUALITY, effort: 4 }).toFile(out);
    } catch (err) {
      console.error(`[compress] FAILED ${src}: ${err.message}`);
      continue;
    }
    const outBytes = await sizeOf(out);
    await rm(src, { force: true });
    before += inBytes;
    after += outBytes;
    converted += 1;
    console.log(
      `[compress] ${src.slice(APP.length + 1)} ${(inBytes / 1024).toFixed(0)}KB → ` +
        `${basename(out)} ${(outBytes / 1024).toFixed(0)}KB`,
    );
  }
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(
  `[compress] ${converted} files: ${mb(before)}MB → ${mb(after)}MB` +
    (before ? ` (-${(100 - (after / before) * 100).toFixed(0)}%)` : ''),
);
