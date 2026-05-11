export type { Pt, Quad, ShirtClass, GarmentSample, ShadingInput } from './types';
export { lerpPt, shadingInputDims } from './types';
export { loadCachedMap, saveCachedMap, decodeCachedMap } from './cache';
export { useModelUrls } from './useModelUrls';
export { quadFromLandmarks } from './quadFromLandmarks';
export { sampleShirtQuadLums, preprocessForShading, buildShadingMap } from './buildShadingMap';
export { buildHighlightMap } from './buildHighlightMap';
export { buildFabricTexture } from './buildFabricTexture';
export { sampleGarment, classifyShirt } from './sampleGarment';
export {
  PRESETS,
  applyGarmentBlend,
  applyCylindricalBend,
  applyEdgeInnerShadow,
} from './composite';
export type { PresetCfg } from './composite';
