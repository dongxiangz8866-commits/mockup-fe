import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// 2026-05-13: hide /models/ originals from picker — only test-models/ shows.
// Source files stay on disk for reference; just removed from scan list.
const MODEL_DIRS = ['public/test-models'];
const PATTERN_DIR = 'public/test-patterns';
const PATTERN = /\.(png|jpe?g|webp)$/i;
const PATTERN_ASSET = /\.(png|jpe?g|webp|svg)$/i;

type AssetEntry = { url: string; mtime: number };

function scanAssetDir(root: string, dir: string, matcher: RegExp): AssetEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('_')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scanAssetDir(root, full, matcher);
    if (!matcher.test(entry.name)) return [];
    const stat = fs.statSync(full);
    const rel = path.relative(root, full).split(path.sep).join('/');
    return [{ url: `/${rel}`, mtime: Math.floor(stat.mtimeMs) }];
  });
}

function scanModels(root: string) {
  return MODEL_DIRS
    .flatMap((rel) => scanAssetDir(root, path.resolve(__dirname, rel), PATTERN))
    .sort((a, b) => a.url.localeCompare(b.url));
}

function scanPatterns(root: string) {
  return scanAssetDir(root, path.resolve(__dirname, PATTERN_DIR), PATTERN_ASSET)
    .sort((a, b) => a.url.localeCompare(b.url));
}

// dev-only: serve a live listing of /public asset dirs so adding/removing
// files reflects without restarting Vite (the build-time `define` snapshot
// is frozen at config load and can't be re-evaluated by HMR). Models and
// patterns get the SAME treatment — one feed each.
function assetsApiPlugin(): Plugin {
  return {
    name: 'mock-research-assets-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const publicRoot = path.resolve(__dirname, 'public');
      const feeds = [
        { route: '/api/models', event: 'models-changed', dirs: MODEL_DIRS, scan: () => scanModels(publicRoot) },
        { route: '/api/patterns', event: 'patterns-changed', dirs: [PATTERN_DIR], scan: () => scanPatterns(publicRoot) },
      ];
      // use() called synchronously here registers the middleware BEFORE
      // Vite's internal transformIndexHtml + spa-fallback. Returning a
      // function would register AFTER, and the html fallback would win.
      server.middlewares.use((req, res, next) => {
        const feed = req.url ? feeds.find((f) => req.url!.startsWith(f.route)) : undefined;
        if (feed) {
          try {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(feed.scan()));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }
        next();
      });
      for (const feed of feeds) {
        const watchDirs = feed.dirs
          .map((rel) => path.resolve(__dirname, rel))
          .filter((dir) => fs.existsSync(dir));
        for (const dir of watchDirs) {
          // fs.watch fires for create/delete/rename; debounce a touch so
          // batched filesystem ops broadcast once.
          let pending: NodeJS.Timeout | null = null;
          fs.watch(dir, { persistent: false }, () => {
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => {
              server.ws.send({ type: 'custom', event: feed.event });
            }, 80);
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), assetsApiPlugin()],
  server: { port: 5174, strictPort: true },
  define: {
    // Build-time snapshot — used by production bundles (no dev API there).
    __MODELS__: JSON.stringify(
      scanModels(path.resolve(__dirname, 'public'))
    ),
    __PATTERNS__: JSON.stringify(
      scanPatterns(path.resolve(__dirname, 'public'))
    ),
  },
});
