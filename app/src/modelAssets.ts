// GLB derived from the OBJ export of the same garment. ~7.9 MB vs the 10 MB
// FBX, and GLTFLoader is far faster than FBXLoader — both reduce startup lag.
// OBJ flips V vs FBX (so V here is positive, V_glb ≈ 1 − V_fbx after offset);
// every UV range below is in the GLB's space.
export const SOURCE_MODEL_DIR = '/mock-models/glb-no-model';
export const SOURCE_MODEL_NAME = '霞湖世家男T-001';
export const SOURCE_MODEL_URL = `${SOURCE_MODEL_DIR}/${encodeURIComponent(
  SOURCE_MODEL_NAME
)}.glb`;

// Front-cloth UV bounds. minV/maxV here name the *endpoints* of the V axis,
// not literal extrema: minV is the V value at the top of the cloth (normalized
// to 0), maxV at the bottom (normalized to 1). The GLB inherited OBJ's flipped
// V (V_glb ≈ 1 − V_fbx), so its V at the top is the larger raw number.
export const FBX_FRONT_UV_BOUNDS = {
  minU: -0.013,
  maxU: 9.606,
  minV: 21.027,
  maxV: 0.284,
};

// 3D mesh bounding box (X/Y in cm). Kept for reference — the bounding box is
// narrower than the flat cloth (the mesh wraps around a body), so we DON'T
// use it to derive cloth dimensions. Use the size-M spec values below instead.
export const FBX_FRONT_POSITION_BOUNDS = {
  minX: -21.455,
  maxX: 21.541,
  minY: 88.713,
  maxY: 155.175,
};

// Garment dimensions for size M (Memebuy 白坯尺寸表, 男T TEE001):
//   衣长 (length) 68 cm, 胸围 (chest) 113 cm → flat front-panel width 56.5 cm.
// The cloth was designed as a flat 2D piece of these dimensions; the UV space
// of the 3D mesh maps directly to this flat panel, so PRINT_*_UV must divide
// by these (not by the bounding-box width).
const CLOTH_W_CM = 113 / 2;
const CLOTH_H_CM = 68;

// Display V at this multiplier of U scale so 1 cm in U = 1 cm in V on screen.
// Normalized UV is non-uniform: 1 U = CLOTH_W_CM, 1 V = CLOTH_H_CM on cloth.
export const EDITOR_V_FACTOR = CLOTH_H_CM / CLOTH_W_CM;

// Print plate spec (Memebuy 白坯尺寸表, 男T TEE001):
//   front 正面: 领下 5 cm, height 18 in (45.72 cm), width 16 in (40.64 cm)
// Pattern is fixed-physical-size, independent of garment size.
export const PRINT_W_CM = 40.64;
export const PRINT_H_CM = 45.72;
export const PRINT_ASPECT = PRINT_W_CM / PRINT_H_CM;
// Print area in normalized UV — sized so cloth result is exactly PRINT_W_CM × PRINT_H_CM
export const PRINT_W_UV = PRINT_W_CM / CLOTH_W_CM;
export const PRINT_H_UV = PRINT_H_CM / CLOTH_H_CM;

// Print area top: 5 cm below the neckline (spec). The front neckline dips
// ~7 cm below the shoulder seam (cloth-top, V=0) on a standard crew, so the
// print area starts at 12 cm down.
const COLLAR_BOTTOM_CM = 7;
const PRINT_TOP_OFFSET_CM = COLLAR_BOTTOM_CM + 5;
export const PRINT_U = 0.5 - PRINT_W_UV / 2;
export const PRINT_V = PRINT_TOP_OFFSET_CM / CLOTH_H_CM;

// Focus to fit the drooping-sleeve silhouette. Sleeves hang at ~35° below
// horizontal so their horizontal extent is sleeve_len * cos(35°) past each
// shoulder corner — see shirtOutline.ts.
export const FOCUS_BOUNDS = {
  minU: -0.34,
  maxU: 1.34,
  minV: -0.04,
  maxV: 1.04,
};

// Three's GLTFLoader names the Mesh from the node, not the mesh definition
// (so `ClothPiece_Fabric_0_ClothPiece_3`, without the `_1` primitive suffix
// that appears in the JSON's `meshes[].name`).
export const FRONT_CLOTH_MESH = 'ClothPiece_Fabric_0_ClothPiece_3';
