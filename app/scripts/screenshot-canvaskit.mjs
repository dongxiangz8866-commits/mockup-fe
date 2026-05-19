// Headless screenshot harness for the /canvaskit route (Skia dual-pass).
//
// Sibling of screenshot-displace.mjs — same file-input pattern seeding and
// one-photo-at-a-time click loop, but targets main[data-ck-status] and the
// /#/canvaskit hash route. Output filenames are index-prefixed because the
// test-models set is mostly Chinese names that slugify to identical strings.
//
// Usage:
//   SCREENSHOT_OUT=canvaskit-foldK-after node scripts/screenshot-canvaskit.mjs [filterRegex]

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const URL_BASE = process.env.SCREENSHOT_URL || 'http://localhost:5174/#/canvaskit';
const OUT_DIR = resolve(APP_ROOT, 'screenshots', process.env.SCREENSHOT_OUT || 'canvaskit-after');
const USER_DATA_DIR = resolve(APP_ROOT, '.playwright-cache');
const FILTER = process.argv[2] ?? null;
const READY_TIMEOUT = 120_000;

const filterRe = FILTER ? new RegExp(FILTER, 'i') : null;

// SWATCH=yellow (default, preserves prior baselines) | whiteblob (white bg +
// centred orange ellipse — mimics the croissant: tests that flat white stays
// CLEAN while the coloured subject still takes drape shading).
function makeSwatch(page, kind) {
  return page.evaluate((k) => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    if (k === 'whiteblob') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 512, 512);
      ctx.fillStyle = '#e8a14d';
      ctx.beginPath();
      ctx.ellipse(256, 256, 150, 110, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#ffd91a';
      ctx.fillRect(0, 0, 512, 512);
    }
    return c.toDataURL('image/png');
  }, kind);
}

async function seedPatternViaInput(page, dataUrl) {
  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const inputs = await page.$$('input[type="file"][accept^="image"]');
  if (inputs.length < 2) throw new Error(`expected ≥2 file inputs, found ${inputs.length}`);
  await inputs[1].setInputFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: buf });
}

function slugify(url) {
  return url
    .replace(/^.*\//, '')
    .replace(/\?.*$/, '')
    .replace(/\.(png|jpg|jpeg|webp)$/i, '')
    .replace(/[^a-z0-9._-]/gi, '_');
}

async function captureOne(page, idx, total, button) {
  const photoSrc = await button.getAttribute('data-photo-src');
  if (!photoSrc) return { skipped: true };
  const slug = slugify(photoSrc);
  if (filterRe && !filterRe.test(slug)) return { skipped: true };

  console.log(`[canvaskit] (${idx + 1}/${total}) ${slug} → click`);
  await page.evaluate((src) => {
    const btn = document.querySelector(`button[data-photo-src="${CSS.escape(src)}"]`);
    if (!btn) throw new Error(`button not found for ${src}`);
    btn.click();
  }, photoSrc);

  try {
    await page.waitForFunction(
      (expected) => {
        const m = document.querySelector('main[data-ck-status]');
        return !!m && m.getAttribute('data-photo-src') === expected;
      },
      photoSrc,
      { timeout: 15_000, polling: 100 }
    );
    await page.waitForFunction(
      (expected) => {
        const m = document.querySelector('main[data-ck-status]');
        if (!m || m.getAttribute('data-photo-src') !== expected) return false;
        const s = m.getAttribute('data-ck-status');
        const d = m.getAttribute('data-depth-state');
        const h = m.getAttribute('data-hair-state');
        const c = m.getAttribute('data-cloth-state');
        if (s === 'fail') return true;
        return s === 'ready'
          && (d === 'ready' || d === 'fail')
          && (h === 'ready' || h === 'fail')
          && (c === 'ready' || c === 'fail');
      },
      photoSrc,
      { timeout: READY_TIMEOUT, polling: 500 }
    );
  } catch {
    const m = await page.$('main[data-ck-status]');
    const st = m ? await m.getAttribute('data-ck-status') : 'no-main';
    console.warn(`[canvaskit] ${slug} timeout (status=${st})`);
    return { skipped: true };
  }

  await page.waitForTimeout(800);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('main[data-ck-status] canvas');
    if (!canvas) return null;
    canvas.dispatchEvent(new MouseEvent('mousemove'));
    return canvas.toDataURL('image/png');
  });
  if (!dataUrl) return { skipped: true };

  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const path = resolve(OUT_DIR, `${String(idx).padStart(2, '0')}-${slug}.png`);
  await writeFile(path, buf);
  console.log(`[canvaskit] wrote ${path}`);
  return { skipped: false };
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 2,
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-webgl', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.type();
    const tx = m.text();
    if (t === 'error') console.error('[browser]', tx);
    else if (tx.startsWith('[canvaskit]') || tx.startsWith('[lightStats]') || tx.startsWith('[foldCalib]') || tx.startsWith('[depth]')) {
      console.log(tx);
    }
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  console.log('[canvaskit] goto', URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const dataUrl = await makeSwatch(page, process.env.SWATCH || 'yellow');
  await seedPatternViaInput(page, dataUrl);

  await page.waitForSelector('button[data-photo-src]', { timeout: 30_000 });
  const buttons = await page.$$('button[data-photo-src]');
  console.log(`[canvaskit] ${buttons.length} preset photos detected`);

  let captured = 0;
  let skipped = 0;
  for (let i = 0; i < buttons.length; i++) {
    const r = await captureOne(page, i, buttons.length, buttons[i]);
    if (r.skipped) skipped++;
    else captured++;
  }

  await ctx.close();
  console.log(`[canvaskit] done. captured=${captured} skipped=${skipped}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
