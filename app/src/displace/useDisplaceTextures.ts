import { useEffect, useMemo } from 'react';
import type * as THREE from 'three';
import type { DerivedMaps } from './MapPipeline';
import {
  canvasToTexture,
  dataCanvasToTexture,
  imageToTexture,
  rasterizePattern,
} from './textures';

// Texture lifecycle is non-trivial: each one wraps a GPU resource that
// `Texture.dispose()` must release. Co-locating the useMemo and its cleanup
// keeps the rule "old texture is disposed before its replacement is used"
// from leaking out into DisplacePage and getting forgotten.

export type DisplaceTextures = {
  photoTex: THREE.Texture | null;
  patternTex: THREE.Texture | null;
  displaceTex: THREE.Texture | null;
  lightTex: THREE.Texture | null;
  shadingTex: THREE.Texture | null;
};

export function useDisplaceTextures(
  photo: HTMLImageElement | null,
  patternImg: HTMLImageElement | null,
  maps: DerivedMaps | null
): DisplaceTextures {
  const photoTex = useMemo(() => (photo ? imageToTexture(photo) : null), [photo]);
  const patternTex = useMemo(
    () => (patternImg ? canvasToTexture(rasterizePattern(patternImg)) : null),
    [patternImg]
  );
  const displaceTex = useMemo(() => (maps ? dataCanvasToTexture(maps.displace) : null), [maps]);
  const lightTex = useMemo(() => (maps ? dataCanvasToTexture(maps.light) : null), [maps]);
  const shadingTex = useMemo(() => (maps ? dataCanvasToTexture(maps.shading) : null), [maps]);

  useEffect(() => () => { photoTex?.dispose(); }, [photoTex]);
  useEffect(() => () => { patternTex?.dispose(); }, [patternTex]);
  useEffect(() => () => { displaceTex?.dispose(); }, [displaceTex]);
  useEffect(() => () => { lightTex?.dispose(); }, [lightTex]);
  useEffect(() => () => { shadingTex?.dispose(); }, [shadingTex]);

  return { photoTex, patternTex, displaceTex, lightTex, shadingTex };
}
