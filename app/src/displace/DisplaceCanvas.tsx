import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Quad } from '../shading';
import { frag, makeUniforms, vert, type DisplaceUniforms } from './displaceShader';
import { recordPrint, recordRender } from './perfBus';

export type DebugMode = 'composite' | 'displace' | 'light' | 'shading' | 'fine' | 'foldGrad' | 'cloth' | 'smoothField';

const debugModeIndex: Record<DebugMode, number> = {
  composite: 0,
  displace: 1,
  light: 2,
  shading: 3,
  fine: 4,
  foldGrad: 5,
  cloth: 6,
  smoothField: 7,
};

type Props = {
  photoTex: THREE.Texture;
  patternTex: THREE.Texture;
  displaceTex: THREE.Texture;
  wrinkleDisplaceTex: THREE.Texture;
  lightTex: THREE.Texture;
  shadingTex: THREE.Texture;
  smoothTex: THREE.Texture;
  photoSize: { w: number; h: number };
  quad: Quad;
  patternAspect: number;
  strength: number;
  dispSign: number;
  depthWrap: number;
  wrinkleStrength: number;
  smoothWarp: number;
  smoothCenter: number;
  shadingP10: number;
  shadingP90: number;
  zCenter: number;
  zRange: number;
  printCenterUV: [number, number];
  envRGB: [number, number, number];
  garmentRGB: [number, number, number];
  hairTex: THREE.Texture;
  clothTex: THREE.Texture;
  tint: number;
  sceneBrightness: number;
  lift: number;
  lightStrength: number;
  debugMode: DebugMode;
  // Changes whenever photo OR pattern changes — the render probe times from
  // here to the next painted frame ("印图渲染耗时") and samples renderer.info.
  renderKey: string;
};

// Lives inside <Canvas> so it can reach the WebGLRenderer via r3f hooks.
// "印图渲染" = wall time from a photo/pattern input change to the first
// frame that paints it; renderer.info is sampled sparsely (every 32 frames)
// to surface texture/VRAM leaks without per-frame churn.
function PerfProbe({ renderKey }: { renderKey: string }) {
  const gl = useThree((state) => state.gl);
  const pendingSince = useRef<number | null>(null);
  const lastKey = useRef('');
  const frame = useRef(0);

  useEffect(() => {
    if (renderKey && renderKey !== lastKey.current) {
      lastKey.current = renderKey;
      pendingSince.current = performance.now();
    }
  }, [renderKey]);

  useFrame(() => {
    if (pendingSince.current != null) {
      recordPrint(performance.now() - pendingSince.current);
      pendingSince.current = null;
    }
    if ((frame.current++ & 31) === 0) {
      recordRender({
        textures: gl.info.memory.textures,
        geometries: gl.info.memory.geometries,
        programs: gl.info.programs?.length ?? 0,
      });
    }
  });

  return null;
}

export default function DisplaceCanvas(p: Props) {
  const uniforms = useMemo<DisplaceUniforms>(() => makeUniforms(), []);

  // Bind reference values into uniforms — Three rebuilds the program lazily
  // on first render, so as long as the .value is set before render time r3f
  // picks it up.
  useEffect(() => {
    uniforms.uPhoto.value = p.photoTex;
    uniforms.uPattern.value = p.patternTex;
    uniforms.uDisplace.value = p.displaceTex;
    uniforms.uWrinkleDisplace.value = p.wrinkleDisplaceTex;
    uniforms.uLight.value = p.lightTex;
    uniforms.uShading.value = p.shadingTex;
    uniforms.uSmoothField.value = p.smoothTex;
    uniforms.uHairMask.value = p.hairTex;
    uniforms.uClothMask.value = p.clothTex;
  }, [
    uniforms,
    p.photoTex,
    p.patternTex,
    p.displaceTex,
    p.wrinkleDisplaceTex,
    p.lightTex,
    p.shadingTex,
    p.smoothTex,
    p.hairTex,
    p.clothTex,
  ]);

  useEffect(() => {
    uniforms.uPhotoSize.value.set(p.photoSize.w, p.photoSize.h);
  }, [uniforms, p.photoSize.w, p.photoSize.h]);

  useEffect(() => {
    const W = p.photoSize.w;
    const H = p.photoSize.h;
    uniforms.uQuadTL.value.set(p.quad.tl.x / W, p.quad.tl.y / H);
    uniforms.uQuadTR.value.set(p.quad.tr.x / W, p.quad.tr.y / H);
    uniforms.uQuadBL.value.set(p.quad.bl.x / W, p.quad.bl.y / H);
  }, [uniforms, p.quad, p.photoSize.w, p.photoSize.h]);

  useEffect(() => {
    uniforms.uPatternAspect.value = p.patternAspect;
  }, [uniforms, p.patternAspect]);

  useEffect(() => {
    uniforms.uStrength.value = p.strength;
  }, [uniforms, p.strength]);

  useEffect(() => {
    uniforms.uDispSign.value = p.dispSign;
  }, [uniforms, p.dispSign]);

  useEffect(() => {
    uniforms.uDepthWrap.value = p.depthWrap;
  }, [uniforms, p.depthWrap]);

  useEffect(() => {
    uniforms.uWrinkleStrength.value = p.wrinkleStrength;
  }, [uniforms, p.wrinkleStrength]);

  useEffect(() => {
    uniforms.uSmoothWarp.value = p.smoothWarp;
  }, [uniforms, p.smoothWarp]);

  useEffect(() => {
    uniforms.uSmoothCenter.value = p.smoothCenter;
  }, [uniforms, p.smoothCenter]);

  useEffect(() => {
    uniforms.uShadingP10.value = p.shadingP10;
    uniforms.uShadingP90.value = p.shadingP90;
  }, [uniforms, p.shadingP10, p.shadingP90]);

  useEffect(() => {
    uniforms.uPrintCenterUV.value.set(p.printCenterUV[0], p.printCenterUV[1]);
  }, [uniforms, p.printCenterUV]);

  useEffect(() => {
    uniforms.uZCenter.value = p.zCenter;
  }, [uniforms, p.zCenter]);

  useEffect(() => {
    uniforms.uZRange.value = p.zRange;
  }, [uniforms, p.zRange]);

  useEffect(() => {
    uniforms.uEnvRGB.value.set(p.envRGB[0], p.envRGB[1], p.envRGB[2]);
  }, [uniforms, p.envRGB]);

  useEffect(() => {
    uniforms.uGarmentRGB.value.set(p.garmentRGB[0], p.garmentRGB[1], p.garmentRGB[2]);
  }, [uniforms, p.garmentRGB]);

  useEffect(() => {
    uniforms.uTint.value = p.tint;
  }, [uniforms, p.tint]);

  useEffect(() => {
    uniforms.uSceneBrightness.value = p.sceneBrightness;
  }, [uniforms, p.sceneBrightness]);

  useEffect(() => {
    uniforms.uLift.value = p.lift;
  }, [uniforms, p.lift]);

  useEffect(() => {
    uniforms.uLightStrength.value = p.lightStrength;
  }, [uniforms, p.lightStrength]);

  useEffect(() => {
    uniforms.uDebugMode.value = debugModeIndex[p.debugMode];
  }, [uniforms, p.debugMode]);

  return (
    <Canvas
      orthographic
      camera={{ left: -1, right: 1, top: 1, bottom: -1, near: 0, far: 2, position: [0, 0, 1] }}
      gl={{
        preserveDrawingBuffer: true,
        antialias: false,
        // r3f defaults: ACESFilmicToneMapping + outputColorSpace=SRGBColorSpace.
        // Both bake assumptions for 3D PBR pipelines; for our 2D composite
        // they corrupt the photo:
        //   • ACES crushes darks → black-shirt fold detail vanishes.
        //   • outputColorSpace=sRGB applies linear→sRGB encoding on the way
        //     out. Custom ShaderMaterial does NOT auto-decode sRGB textures
        //     (only built-in materials do), so the shader is already reading
        //     sRGB bytes; re-encoding them on output gives DOUBLE sRGB
        //     gamma → photo looks visibly darker than the source.
        // Pairing NoToneMapping + LinearSRGBColorSpace with NoColorSpace on
        // every texture (see textures.ts) makes the whole pipeline a byte
        // pass-through for the photo.
        toneMapping: THREE.NoToneMapping,
        outputColorSpace: THREE.LinearSRGBColorSpace,
      }}
      dpr={[1, 2]}
      style={{ width: '100%', height: '100%' }}
    >
      <PerfProbe renderKey={p.renderKey} />
      <mesh>
        {/* 32×32 subdivision = 1089 vertices. Vertex shader samples the
            warp sources at each vertex and outputs the warped pattern UV
            as a varying; GPU interpolates between adjacent vertices →
            smooth pattern warp across the print area without per-pixel
            artefacts (the wave/slash failure mode the per-fragment warp
            kept producing). See displaceShader.ts for the architecture
            rationale.

            Vertex density: at a 1500-px-wide photo, 32 segments places
            vertices ~47 px apart. Folds smaller than that are smoothed
            into the interpolation; folds larger than 50 px (the regime
            the user actually cares about) bend the print smoothly. */}
        <planeGeometry args={[2, 2, 32, 32]} />
        <shaderMaterial
          vertexShader={vert}
          fragmentShader={frag}
          uniforms={uniforms as unknown as Record<string, THREE.IUniform>}
          depthTest={false}
          depthWrite={false}
          transparent={false}
        />
      </mesh>
    </Canvas>
  );
}
