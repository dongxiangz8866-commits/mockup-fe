import { useEffect, useState } from 'react';

type ModelEntry = { url: string; mtime: number };
const toUrls = (list: ModelEntry[]) => list.map((m) => `${m.url}?v=${m.mtime}`);

// Dev: poll /api/models so add/delete in /public/models reflects without
// restarting Vite (build-time __MODELS__ is frozen at config load). The
// dev plugin also broadcasts a custom HMR event on directory change.
export function useModelUrls(): string[] {
  const [urls, setUrls] = useState<string[]>(() => toUrls(__MODELS__));
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/models');
        if (!r.ok) return;
        const list = (await r.json()) as ModelEntry[];
        if (!cancelled) setUrls(toUrls(list));
      } catch {
        // ignore — keep last known list
      }
    };
    refresh();
    if (import.meta.hot) {
      import.meta.hot.on('models-changed', refresh);
      return () => {
        cancelled = true;
        import.meta.hot?.off('models-changed', refresh);
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return urls;
}
