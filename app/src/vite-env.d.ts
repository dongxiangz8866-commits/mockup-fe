/// <reference types="vite/client" />

declare const __MODELS__: Array<{ url: string; mtime: number }>;
declare const __PATTERNS__: Array<{ url: string; mtime: number }>;

interface ImportMetaEnv {
  // Set at build to serve picker assets from a CDN (e.g. jsDelivr).
  // Unset in dev → assets served locally from the Vite public dir.
  readonly VITE_ASSET_CDN?: string;
}
