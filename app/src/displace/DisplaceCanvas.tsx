import { Canvas } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Quad } from '../shading';
import { frag, makeUniforms, vert, type DisplaceUniforms } from './displaceShader';

export type DebugMode = 'composite' | 'displace' | 'light' | 'shading';

const debugModeIndex: Record<DebugMode, number> = {
  composite: 0,
  displace: 1,
  light: 2,
  shading: 3,
};

type Props = {
  photoTex: THREE.Texture;
  patternTex: THREE.Texture;
  displaceTex: THREE.Texture;
  lightTex: THREE.Texture;
  shadingTex: THREE.Texture;
  photoSize: { w: number; h: number };
  quad: Quad;
  strength: number;
  ampPx: number;
  lightStrength: number;
  debugMode: DebugMode;
};

export default function DisplaceCanvas(p: Props) {
  const uniforms = useMemo<DisplaceUniforms>(() => makeUniforms(), []);

  // Bind reference values into uniforms — Three rebuilds the program lazily
  // on first render, so as long as the .value is set before render time r3f
  // picks it up.
  useEffect(() => {
    uniforms.uPhoto.value = p.photoTex;
    uniforms.uPattern.value = p.patternTex;
    uniforms.uDisplace.value = p.displaceTex;
    uniforms.uLight.value = p.lightTex;
    uniforms.uShading.value = p.shadingTex;
  }, [uniforms, p.photoTex, p.patternTex, p.displaceTex, p.lightTex, p.shadingTex]);

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
    uniforms.uStrength.value = p.strength;
  }, [uniforms, p.strength]);

  useEffect(() => {
    uniforms.uAmpPx.value = p.ampPx;
  }, [uniforms, p.ampPx]);

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
      <mesh>
        <planeGeometry args={[2, 2]} />
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
