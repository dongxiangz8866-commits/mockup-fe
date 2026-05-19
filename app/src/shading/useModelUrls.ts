import { useEffect, useState } from 'react';

type AssetEntry = { url: string; mtime: number };

// Build-time opt-in: serve the picker dirs from a CDN (jsDelivr off the
// public repo). Dev leaves it unset → local Vite paths, unchanged. The
// scanned url keeps spaces / CJK / parens (Chinese sample filenames), so
// encode the CDN form — jsDelivr 404s on raw non-ASCII path segments.
const CDN = import.meta.env.VITE_ASSET_CDN?.replace(/\/+$/, '');
const toUrls = (list: AssetEntry[]) =>
  list.map((m) => (CDN ? `${encodeURI(CDN + m.url)}?v=${m.mtime}` : `${m.url}?v=${m.mtime}`));

// Dev: poll the live listing endpoint so add/delete in the asset dir
// reflects without restarting Vite (the build-time __MODELS__ / __PATTERNS__
// define snapshot is frozen at config load). The dev plugin also broadcasts
// a custom HMR event on directory change. Production has no dev API, so it
// falls back to the frozen build-time snapshot passed as `initial`.
function useAssetUrls(endpoint: string, hmrEvent: string, initial: AssetEntry[]): string[] {
  const [urls, setUrls] = useState<string[]>(() => toUrls(initial));
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch(endpoint);
        if (!r.ok) return;
        const list = (await r.json()) as AssetEntry[];
        if (!cancelled) setUrls(toUrls(list));
      } catch {
        // ignore — keep last known list
      }
    };
    refresh();
    if (import.meta.hot) {
      import.meta.hot.on(hmrEvent, refresh);
      return () => {
        cancelled = true;
        import.meta.hot?.off(hmrEvent, refresh);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [endpoint, hmrEvent]);
  return urls;
}

export function useModelUrls(): string[] {
  return useAssetUrls('/api/models', 'models-changed', __MODELS__);
}

export function usePatternUrls(): string[] {
  return useAssetUrls('/api/patterns', 'patterns-changed', __PATTERNS__);
}
