// Headless screenshot harness for the 样机系统 thumbnail grid.
//
// Why: changes to the shading-map / blend pipeline (ModelGrid.tsx) only
// manifest visually. Without a screenshot path the only verification was
// "load the dev page in a real browser and squint", which doesn't compose
// with iterative tuning. This script captures every `.model-canvas` thumb
// (or a regex-filtered subset) into `app/screenshots/` so cross-commit
// pixel diffs are mechanical.
//
// Pose-detection cache: MediaPipe runs inside the page and caches landmarks
// to localStorage. We point Chromium at a persistent `userDataDir` so the
// second run skips the ~1-2s/image pose pass.
//
// Pattern injection: an empty pattern means `tmp` never gets drawn and the
// shading pass is invisible. We pre-seed `pattern-cache:v1` with a solid
// saturated yellow square so the shading hard-light darkening reads clearly
// on every shirt color. The box is centred in the print area's UV.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const URL_BASE = process.env.SCREENSHOT_URL || 'http://localhost:5174/';
const OUT_DIR = resolve(APP_ROOT, 'screenshots');
const USER_DATA_DIR = resolve(APP_ROOT, '.playwright-cache');
const FILTER = process.argv[2] ?? null; // optional regex against filename
const PER_ITEM_TIMEOUT = 90_000;

const filterRe = FILTER ? new RegExp(FILTER, 'i') : null;

// 512×512 solid yellow PNG, base64 data URL. NO border / NO text — the alpha
// edge of the rectangle IS the only edge, so blend-pipeline effects that act
// on the pattern boundary (notably B1 inner-shadow at step 1.5d) read clean.
// An earlier version of this swatch had a 12 px black border that coincided
// with the alpha edge and visually buried the inner-shadow ring.
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

async function seedPattern(page) {
  const dataUrl = await makeYellowSwatch(page);
  await page.evaluate((d) => {
    // Centred box in the print plate's UV: u/v are pattern-box origin within
    // the print region [0..1]², w/h are sizes in the same UV. (0.20, 0.30)
    // and 0.60×0.40 land the swatch over the chest area for every model.
    const box = { u: 0.20, v: 0.30, w: 0.60, h: 0.40 };
    localStorage.setItem('pattern-cache:v1', JSON.stringify({ dataUrl: d, box }));
  }, dataUrl);
}

function slugify(url) {
  return url
    .replace(/^.*\//, '')
    .replace(/\?.*$/, '')
    .replace(/\.(png|jpg|jpeg|webp)$/i, '')
    .replace(/[^a-z0-9._-]/gi, '_');
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log('[screenshot] launching chromium');
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 2,
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') console.error('[browser]', m.text());
    else if (t === 'log' && (m.text().startsWith('[A1]') || m.text().startsWith('[blend]') || m.text().startsWith('[classify]'))) console.log(m.text());
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // First navigation just to gain a window/localStorage scope for seeding.
  console.log('[screenshot] goto', URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await seedPattern(page);
  // CLEAR_SHADING=1 evicts the v9/v2 shading caches before reload so each
  // run rebuilds them and any preprocess-side debug logs fire. Pattern,
  // pose, highlight, fabric caches are kept (re-deriving them every run is
  // wasteful and they are not what we're iterating on).
  if (process.env.CLEAR_SHADING === '1') {
    await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.startsWith('sh-cache:') || k.startsWith('wsh-cache:')) {
          localStorage.removeItem(k);
        }
      }
    });
    console.log('[screenshot] cleared shading-map localStorage entries');
  }
  // Reload so the editor's pattern-cache hydration effect fires with the
  // freshly-seeded entry (it only reads on first mount).
  await page.reload({ waitUntil: 'domcontentloaded' });

  try {
    await page.waitForSelector('.model-item', { timeout: 90_000, state: 'attached' });
  } catch (e) {
    const dump = resolve(OUT_DIR, '_debug-page.png');
    await page.screenshot({ path: dump, fullPage: true });
    const html = await page.content();
    console.error('[screenshot] no .model-item found. dumped DOM + screenshot:');
    console.error('  - DOM length:', html.length);
    console.error('  - body inner length:', await page.$eval('body', (el) => el.innerHTML.length).catch(() => '?'));
    console.error('  - debug screenshot:', dump);
    console.error('  - first 1000 chars of body innerHTML:');
    console.error(await page.$eval('body', (el) => el.innerHTML.slice(0, 1000)).catch(() => '<eval failed>'));
    throw e;
  }
  const total = await page.$$eval('.model-item', (els) => els.length);
  console.log(`[screenshot] ${total} thumbnails detected, waiting for ready...`);

  // Per-item ready wait. Avoids a single global timeout if one image's pose
  // detection chokes — we still capture the rest.
  await page.waitForFunction(
    () => {
      const items = Array.from(document.querySelectorAll('.model-item'));
      if (items.length === 0) return false;
      // Accept ready or fail (fail = pose missed; we still want a screenshot
      // of the bare photo).
      return items.every((it) => {
        const s = it.getAttribute('data-model-status');
        return s === 'ready' || s === 'fail';
      });
    },
    null,
    { timeout: PER_ITEM_TIMEOUT * 2, polling: 500 }
  );

  const items = await page.$$('.model-item');
  let captured = 0;
  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    const url = (await items[i].getAttribute('data-model-url')) ?? `idx-${i}`;
    const status = await items[i].getAttribute('data-model-status');
    const slug = slugify(url);
    if (filterRe && !filterRe.test(slug)) {
      skipped++;
      continue;
    }
    if (status !== 'ready') {
      console.warn(`[screenshot] ${slug} status=${status}, capturing anyway`);
    }
    // Capture at the canvas's NATIVE pixel resolution (toDataURL) instead of
    // the CSS-rendered size from element.screenshot. The composite runs on a
    // 1024² canvas styled down to ~250 px wide; CSS-size screenshots bury
    // sub-pixel effects (B1 inner shadow is 2 px ≈ 0.5 px in CSS) under
    // resampling. Native pixels preserve every blend-pass detail.
    const dataUrl = await items[i].$eval('.model-canvas', (el) =>
      (el).toDataURL('image/png')
    ).catch(() => null);
    if (!dataUrl) {
      console.warn(`[screenshot] ${slug} no canvas data, skipping`);
      continue;
    }
    const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const path = resolve(OUT_DIR, `${slug}.png`);
    await writeFile(path, buf);
    console.log(`[screenshot] wrote ${path}`);
    captured++;
  }

  await ctx.close();
  console.log(`[screenshot] done. captured=${captured} skipped=${skipped}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
