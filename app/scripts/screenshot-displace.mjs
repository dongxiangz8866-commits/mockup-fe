// Headless screenshot harness for the /displace route (深度路径 baseline).
//
// Mirrors scripts/screenshot-thumbs.mjs but targets the WebGL displace
// pipeline. Output → app/screenshots/displace-baseline/<slug>.png so we can
// run this before + after a tuning change and pixel-diff.
//
// Why a separate script: the / route renders all thumbs in parallel, but
// /displace renders one photo at a time (PhotoPicker.onClick swaps photoSrc).
// We have to click each thumb, wait for ready + depth state, snapshot, repeat.
//
// Cache notes — first run cold-loads DAv2 (~7 s, then per-photo inference
// ~1-2 s on WebGPU). Subsequent runs read depth from localStorage
// (depth-cache:v1:) so each photo is sub-second.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const URL_BASE = process.env.SCREENSHOT_URL || 'http://localhost:5174/#/displace';
const OUT_DIR = resolve(APP_ROOT, 'screenshots', 'displace-baseline');
const USER_DATA_DIR = resolve(APP_ROOT, '.playwright-cache');
const FILTER = process.argv[2] ?? null;
const READY_TIMEOUT = 120_000;

const filterRe = FILTER ? new RegExp(FILTER, 'i') : null;

function makeYellowSwatch(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffd91a';
    ctx.fillRect(0, 0, 512, 512);
    return c.toDataURL('image/png');
  });
}

// /displace path uses a separate pattern flow than /. The shading route reads
// `pattern-cache:v1`; displace reads `patternSrc` directly from the file
// input. To seed without a file pick, we mock `URL.createObjectURL` to return
// a known data-URL whenever the page asks for one — but the screenshot
// harness simpler path is: pass the swatch through window's File API by
// dispatching a synthetic change on the upload input.
async function seedPatternViaInput(page, dataUrl) {
  // Convert dataURL → Uint8Array → File → DataTransfer → dispatch change on
  // the pattern <input type="file">. This is how Playwright recommends
  // injecting file uploads programmatically.
  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const inputs = await page.$$('input[type="file"][accept^="image"]');
  if (inputs.length < 2) throw new Error(`expected ≥2 file inputs (photo upload + pattern upload), found ${inputs.length}`);
  // PhotoPicker's input is first, DisplacePage's pattern input is second.
  await inputs[1].setInputFiles({
    name: 'swatch.png',
    mimeType: 'image/png',
    buffer: buf,
  });
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
  if (!photoSrc) return { skipped: true, reason: 'no data-photo-src' };
  const slug = slugify(photoSrc);
  if (filterRe && !filterRe.test(slug)) return { skipped: true, reason: 'filtered', slug };

  console.log(`[displace] (${idx + 1}/${total}) ${slug} → click`);
  // Playwright's click() does an in-view + actionable check that intermittently
  // fails on horizontally-scrolling picker thumbs even though the React onClick
  // would fire fine. Bypass: invoke .click() in page context directly.
  await page.evaluate((src) => {
    const btn = document.querySelector(`button[data-photo-src="${CSS.escape(src)}"]`);
    if (!btn) throw new Error(`button not found for ${src}`);
    btn.click();
  }, photoSrc);

  // Two-phase wait. Without phase 1, button.click()'s React state update is
  // not yet flushed when waitForFunction runs its first poll, so the page's
  // data-photo-src is STILL the previous photo's src and status is STILL
  // 'ready' from the previous capture → we'd grab the previous frame.
  // Phase 1: data-photo-src moves to the new photo (state propagated).
  // Phase 2: pipeline reaches a terminal state (ready or fail) for it.
  try {
    await page.waitForFunction(
      (expected) => {
        const m = document.querySelector('main[data-displace-status]');
        if (!m) return false;
        return m.getAttribute('data-photo-src') === expected;
      },
      photoSrc,
      { timeout: 15_000, polling: 100 }
    );
    await page.waitForFunction(
      (expected) => {
        const m = document.querySelector('main[data-displace-status]');
        if (!m) return false;
        if (m.getAttribute('data-photo-src') !== expected) return false;
        const s = m.getAttribute('data-displace-status');
        const d = m.getAttribute('data-depth-state');
        const h = m.getAttribute('data-hair-state');
        if (s === 'fail') return true;
        return s === 'ready'
          && (d === 'ready' || d === 'fail')
          && (h === 'ready' || h === 'fail');
      },
      photoSrc,
      { timeout: READY_TIMEOUT, polling: 500 }
    );
  } catch (e) {
    const m = await page.$('main[data-displace-status]');
    const dStatus = m ? await m.getAttribute('data-displace-status') : 'no-main';
    const depth = m ? await m.getAttribute('data-depth-state') : 'no-main';
    console.warn(`[displace] ${slug} timeout (status=${dStatus} depth=${depth})`);
    return { skipped: true, reason: 'ready timeout', slug };
  }

  // Generous post-ready wait so r3f's deferred uniform applies + first paint
  // both flush before we toDataURL. 300 ms (initial) was missing the first
  // and the last of every batch; 800 ms eliminated the misses in testing.
  await page.waitForTimeout(800);

  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('main[data-displace-status] canvas');
    if (!canvas) return null;
    // Force one final flush by triggering r3f's invalidate-cycle: a tiny
    // dispatchEvent('mousemove') on the canvas re-runs frame logic without
    // touching uniforms.
    canvas.dispatchEvent(new MouseEvent('mousemove'));
    return canvas.toDataURL('image/png');
  });
  if (!dataUrl) return { skipped: true, reason: 'no canvas', slug };

  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const path = resolve(OUT_DIR, `${slug}.png`);
  await writeFile(path, buf);
  console.log(`[displace] wrote ${path}`);
  return { skipped: false, slug, path };
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log('[displace] launching chromium');
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 2,
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-webgl',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.type();
    const tx = m.text();
    if (t === 'error') console.error('[browser]', tx);
    else if (t === 'log' && (tx.startsWith('[depth]') || tx.startsWith('[hair]') || tx.startsWith('[overlap]') || tx.startsWith('[env]'))) {
      console.log(tx);
    }
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  console.log('[displace] goto', URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Seed pattern via the file input.
  const dataUrl = await makeYellowSwatch(page);
  await seedPatternViaInput(page, dataUrl);

  // Wait until PhotoPicker has rendered the preset thumbs.
  await page.waitForSelector('button[data-photo-src]', { timeout: 30_000 });
  const buttons = await page.$$('button[data-photo-src]');
  console.log(`[displace] ${buttons.length} preset photos detected`);

  let captured = 0;
  let skipped = 0;
  for (let i = 0; i < buttons.length; i++) {
    const r = await captureOne(page, i, buttons.length, buttons[i]);
    if (r.skipped) skipped++;
    else captured++;
  }

  await ctx.close();
  console.log(`[displace] done. captured=${captured} skipped=${skipped}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
