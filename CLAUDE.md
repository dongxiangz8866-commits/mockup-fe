# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

`mock-research` is a research-and-prototype workspace for a **clothing 样机系统 (mockup system)**: given a model photo and a flat graphic, produce a composite where the graphic is "printed" on the model's garment, conforming to its shape, drape, and lighting. Internally and in user-facing copy we use "样机系统"; "mockup" is reserved for cross-team / English contexts.

Background and the broader technical landscape (2D / 3D / frontend-only / backend) are in [`RESEARCH.md`](./RESEARCH.md). The end-to-end algorithm currently in code is documented in [`docs/synthesis-pipeline.md`](./docs/synthesis-pipeline.md) — read it before changing anything under `app/src/shading/` or `app/src/composeFrame.ts`.

## Inherited standards

The parent file at `../CLAUDE.md` defines the wider workspace standards and applies here:
- Stack: React 18 + TypeScript + Vite, CSS Modules / Less / Tailwind, Three.js for 3D
- Component file ≤ 200 lines, function ≤ 50 lines, single-responsibility
- Strict style isolation; no inline styles except dynamic values; no ID selectors
- Behavioral rules: surface assumptions, simplest solution that solves the problem, surgical changes, define verifiable success criteria

## Build / run

Everything lives in [`app/`](./app) — Vite + React 18 + TypeScript + react-three-fiber + Three.js. pnpm is the package manager (see `pnpm-lock.yaml`).

```bash
cd app
pnpm install         # first run only
pnpm dev             # http://localhost:5174  (port is strict — see vite.config.ts)
pnpm build           # tsc -b && vite build
pnpm preview         # serve the built bundle
pnpm screenshot      # node scripts/screenshot-thumbs.mjs — Playwright thumbnails of all /public/models photos
```

There is no test suite. Verification is visual: run `pnpm dev`, switch between the two routes, and inspect against `app/screenshots/` (and `app/screenshots/before-B/` for regression diffs).

`vite.config.ts` registers a dev-only `/api/models` middleware that lists `public/models/*.{png,jpg,jpeg,webp}` live, plus an `fs.watch` → `models-changed` WS event so adding a photo to `public/models/` reflects without a restart. Production bundles fall back to a build-time snapshot baked into `__MODELS__` (define).

## Two routes, two pipelines

`App.tsx` mounts a `HashRouter` with two routes — they share photo/pose code but diverge sharply on how shading is applied:

- **`/` — 明暗对比 (`ShadingLayout` → `Editor2D` + `ModelGrid`)**
  Canvas2D pipeline. Left panel paints a pattern into a calibrated rectangle inside a shared 4096² canvas (`app/src/textureStore.ts`). Right panel shows that pattern composited onto every photo in `public/models/` via the multi-pass blend pipeline in [`composeFrame.ts`](./app/src/composeFrame.ts) + [`app/src/shading/`](./app/src/shading/). Steps and the math behind each blend (DoG shading, hard-light cap at 128, A1 luminance preprocess for dark shirts, etc.) are in `docs/synthesis-pipeline.md`.

- **`/displace` — 位移派生 (`DisplacePage`)**
  WebGL pipeline. A custom GLSL ShaderMaterial (`displaceShader.ts`) on a plane: photo + warped pattern + displacement source + light/shading maps. Displacement can come from either Sobel-of-DoG (legacy, `dispSource='dog'`) or **DAv2 depth radial wrap** (default, `dispSource='depth'`) — depth path bypasses Sobel and uses the raw depth drop relative to the print center as a radial outward push, which is the only thing that produces visible "wrap" at the chest center where depth gradient ≈ 0.

The shared 4096² canvas is *also* exposed via `Viewer3D` (`app/src/Viewer3D.tsx`) as `MeshStandardMaterial.map` on a `.glb` garment — but `Viewer3D` is no longer wired into either route. Keep the file in mind when touching `textureStore.ts` or `modelAssets.ts` (UV bounds, anisotropy lock).

## Architecture notes that aren't obvious from a file walk

- **`textureStore.ts` is global state.** A single module-level `sharedCanvas` / `sharedTexture` / `pattern` is shared across `Editor2D`, `ModelGrid`, `Viewer3D`, and `DisplacePage`. Pattern updates use a tiny pub-sub with `subscribePattern` + `markTextureDirty`, and notification is **rAF-coalesced** — synchronous fan-out would slideshow drag at 60–120 Hz × N subscribers.

- **`modelAssets.ts` constants are bound to one GLB.** `PRINT_U / PRINT_V / PRINT_W_UV / PRINT_H_UV / GLB_TEX_SCALE_U` are derived from the bundled `霞湖世家男T-001.glb` UV layout + the Memebuy size-M print spec (40.64 × 40.72 cm). The anisotropy ratio `GLB_LOCK_RATIO = 1.092 / 0.929` was *measured* from the mesh by `app/scripts/inspect-front-cloth-uv.mjs`; swap the model and re-run that script.

- **Three caches per derived map.** `useModelAssets.ts` and `useDepthMap.ts` use the same three-tier pattern: in-mem `Map<src, Canvas>` → localStorage half-res JPEG (versioned prefixes `sh-cache:v12:`, `depth-cache:v1:`, etc.) → build. Bump the prefix version when the build function changes its output bytes, or the next page load reads a stale map and silently renders wrong. The per-src in-mem cache is what makes the photo grid feel instant on re-mount.

- **Pose runs before shading-map build.** A1 luminance preprocess (`preprocessForShading`) needs the pose quad to sample the shirt's [P10, P90] before stretching dark shirts into a usable range — see `docs/synthesis-pipeline.md` §A1 and `useModelAssets.ts`. If you move pose later in the load order, dark shirts go back to flat.

- **`garmentMemCache` / `sceneMemCache` are keyed by photo src, not by quad.** Don't change a cache key to include quad — sampling drifts negligibly when the print moves; recomputing on every drag tick freezes the UI. There is a known footgun in `DisplacePage.tsx`: state resets (`setPhoto(null)`, `setQuad(null)`, `setMaps(null)`) must happen *before* awaiting a new image, otherwise the sample useMemos run with `photoSrc=NEW + photo=OLD` and poison the cache under the new key (comment in `DisplacePage.tsx` describes the symptom).

- **Pose & depth singletons reset on rejection.** `poseDetector.getLandmarker` and `depthPipeline.getDepthPipe` clear their cached promise on `.catch` — the naive `if (p) return p` form permanently poisons the singleton after one CDN/WebGPU flake. Both call sites also retry once on throw (but never on `null` returns — that means "no person in image" and is deterministic).

- **`MeshStandardMaterial` auto-decodes sRGB; custom `ShaderMaterial` does not.** Textures in `app/src/displace/textures.ts` are marked `NoColorSpace` and the renderer uses `LinearSRGBColorSpace` so sRGB bytes pass through unchanged. The 3D viewer (`Viewer3D.tsx`) uses `NoToneMapping` + `SRGBColorSpace` for the same reason — ACESFilmic desaturates print colors, which is the single biggest factor in "3D print looks dimmer than source".

- **Heavy assets you don't need to git-track again.** `public/models/` holds 14 photos (~80 MB). The bundled GLB is also in `public/sweatshirt.glb` and in `public/mock-models/glb-no-model/霞湖世家男T-001.glb`. Don't rebuild thumbnails by hand — `pnpm screenshot` regenerates `app/screenshots/`.

## CSS

Global styles live in `app/src/app.css` (route-wide layout, modal, model grid). The only CSS-Modules file currently is `app/src/displace/DisplacePage.module.css`. New components should prefer CSS Modules per the inherited rule — `app.css` predates that convention and is grandfathered.

## Session end checkpoint

`.claude/settings.json` registers a `SessionEnd` hook that, on session termination, captures the current working tree into a `git stash` entry labeled `[session-end YYYY-MM-DD_HH:MM] <first line of summary>` and immediately re-applies it (working tree stays intact; the stash entry is the audit trail). The hook only runs if `.claude/session-summary.md` exists and is non-empty — no summary, no stash.

**Future Claude's job:** When the user signals they're wrapping up (e.g. "结束 / 收工 / 下次再说 / 关掉" / "we're done for today" / `/clear` heads-up), write `.claude/session-summary.md` before responding to or acknowledging the wrap-up. Format:

```
功能: <一句话描述本 session 做了什么>

总结:
- ...

TODO:
- ...
```

The first line becomes the stash title, so keep `功能: ...` punchy and specific. Recover later with `git stash list | grep session-end` then `git stash show -p stash@{N}`.
