# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

`mock-research` is a research-and-prototype workspace for a **clothing 样机系统 (mockup system)**: given a model photo and a flat graphic, produce a composite where the graphic is "printed" on the model's garment, conforming to its shape, drape, and lighting. Internally and in user-facing copy we call this the "样机系统"; "mockup" is reserved for cross-team / English contexts.

The directory currently holds research only (no source code yet). The technical landscape — 2D, 3D, frontend-only, and backend-required approaches — is documented in [`RESEARCH.md`](./RESEARCH.md). Read it before scoping any implementation.

## Working assumption

Frontend-first per the project owner's directive. The recommended starting point in `RESEARCH.md` is the **pixi.js v8 + PSD-style displacement workflow** (RESEARCH.md §3.1 C) — a pre-baked `base / mask / displace / light` asset set composited at runtime by a `DisplacementFilter` or custom GLSL. For arbitrary user photos, the fallback is MediaPipe Pose + a 3D plane (§3.2 F). Backend AI (SD + ControlNet + IP-Adapter, §3.3 H) is the high-quality long tail, not the MVP.

## Inherited standards

The parent file at `../CLAUDE.md` defines the wider workspace standards and applies here:
- Stack: React 18 + TypeScript + Vite, CSS Modules / Less / Tailwind, Three.js for 3D
- Component file ≤ 200 lines, function ≤ 50 lines, single-responsibility
- Strict style isolation; no inline styles except dynamic values; no ID selectors
- Behavioral rules: surface assumptions, simplest solution that solves the problem, surgical changes, define verifiable success criteria

## Build / test / run

First prototype lives in [`app/`](./app) — Vite + React 18 + TypeScript + react-three-fiber, exploring the 3D-texture-swap route (RESEARCH.md §3.2 E). The workspace-root `.glb` is copied to `app/public/sweatshirt.glb` at scaffold time.

```bash
cd app
pnpm install      # first run only
pnpm dev          # http://localhost:5174
pnpm build        # tsc + vite build
```

Layout: left panel is the 2D editor (contour outline + 16×18 drag/scale grid); right panel is the live 3D viewer. A single shared 1024² `<canvas>` is wired in as the model's `MeshStandardMaterial.map`; the editor paints into a calibrated rectangle inside that canvas (`TEX_GRID_X/Y/W` in [`Editor2D.tsx`](./app/src/Editor2D.tsx)) and r3f's `useFrame` flips `texture.needsUpdate` each frame. The printable-region constants assume the bundled `320-all-over-print-sweatshirt-300822.glb` UV layout — swap the model and they must be re-mapped.
