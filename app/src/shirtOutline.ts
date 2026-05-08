// Stylised t-shirt silhouette drawn from the size-M spec
// (Memebuy 白坯尺寸表 男T TEE001).
//
// Coordinates are in normalized cloth UV space:
//   U = 0 left edge of front body panel at chest, U = 1 right edge   (chest/2 = 56.5 cm)
//   V = 0 highest point of cloth (neckline corner level), V = 1 hem  (衣长 = 68 cm)
//
// Shape elements driven by the spec:
//   - 肩宽 53 cm  → shoulder seam inset 1.75 cm from each chest side
//   - 下摆围 114 cm → hem 0.25 cm wider than chest each side (slight flare)
//   - 袖长 23.5 cm → sleeve length along seam direction
//   - 袖口围 37.5 cm → cuff flat width 18.75 cm, perpendicular to sleeve
//   - Shoulder drops 4 cm from neckline corner (visible 肩斜)
//   - Sleeves droop SLEEVE_DROOP_DEG below horizontal from the shoulder corner

// --- Spec values ---
const BODY_W_CM = 56.5;        // 胸围 113 / 2
const BODY_H_CM = 68;          // 衣长
const SHOULDER_W_CM = 53;      // 肩宽
const HEM_W_CM = 57;           // 下摆围 114 / 2
const SLEEVE_LEN_CM = 23.5;    // 袖长
const CUFF_FLAT_CM = 18.75;    // 袖口围 / 2

// --- Estimated (not in the size table) ---
const NECK_HALF_W_CM = 7;
const NECK_DEPTH_FRONT_CM = 7;
const NECK_DEPTH_BACK_CM = 2.5;
const ARMPIT_FROM_TOP_CM = 22;
const SHOULDER_DROP_CM = 4;    // shoulder corner sits this far below neckline corner
const SLEEVE_DROOP_DEG = 35;   // angle below horizontal

// --- Normalized geometry ---
const NECK_HALF_W = NECK_HALF_W_CM / BODY_W_CM;
const NECK_DEPTH_FRONT = NECK_DEPTH_FRONT_CM / BODY_H_CM;
const NECK_DEPTH_BACK = NECK_DEPTH_BACK_CM / BODY_H_CM;
const ARMPIT_V = ARMPIT_FROM_TOP_CM / BODY_H_CM;
const SHOULDER_DROP_V = SHOULDER_DROP_CM / BODY_H_CM;

const SHOULDER_INSET_U = (BODY_W_CM - SHOULDER_W_CM) / 2 / BODY_W_CM;
const HEM_OUTSET_U = (HEM_W_CM - BODY_W_CM) / 2 / BODY_W_CM;

const NECK_LEFT_U = 0.5 - NECK_HALF_W;
const NECK_RIGHT_U = 0.5 + NECK_HALF_W;
const SHOULDER_LEFT_U = SHOULDER_INSET_U;
const SHOULDER_RIGHT_U = 1 - SHOULDER_INSET_U;
const HEM_LEFT_U = -HEM_OUTSET_U;
const HEM_RIGHT_U = 1 + HEM_OUTSET_U;

// --- Drooping sleeve geometry ---
// Sleeve direction at shoulder corner is `SLEEVE_DROOP_DEG` below horizontal.
// Cuff is perpendicular to the sleeve direction (matches real cut).
// Compute endpoints in cm-space (so 1 cm in U = 1 cm in V) then convert to UV.
const droopRad = (SLEEVE_DROOP_DEG * Math.PI) / 180;
const sCos = Math.cos(droopRad);
const sSin = Math.sin(droopRad);

type Pt = { u: number; v: number };
const cmToUV = (xCm: number, yCm: number): Pt => ({
  u: xCm / BODY_W_CM,
  v: yCm / BODY_H_CM,
});

const leftShoulderXcm = SHOULDER_LEFT_U * BODY_W_CM;
const shoulderYcm = SHOULDER_DROP_V * BODY_H_CM;
const leftCuffTopXcm = leftShoulderXcm - SLEEVE_LEN_CM * sCos;
const leftCuffTopYcm = shoulderYcm + SLEEVE_LEN_CM * sSin;
const leftCuffBotXcm = leftCuffTopXcm + CUFF_FLAT_CM * sSin;
const leftCuffBotYcm = leftCuffTopYcm + CUFF_FLAT_CM * sCos;
const leftCuffTop = cmToUV(leftCuffTopXcm, leftCuffTopYcm);
const leftCuffBot = cmToUV(leftCuffBotXcm, leftCuffBotYcm);

const rightShoulderXcm = SHOULDER_RIGHT_U * BODY_W_CM;
const rightCuffTopXcm = rightShoulderXcm + SLEEVE_LEN_CM * sCos;
const rightCuffTopYcm = shoulderYcm + SLEEVE_LEN_CM * sSin;
const rightCuffBotXcm = rightCuffTopXcm - CUFF_FLAT_CM * sSin;
const rightCuffBotYcm = rightCuffTopYcm + CUFF_FLAT_CM * sCos;
const rightCuffTop = cmToUV(rightCuffTopXcm, rightCuffTopYcm);
const rightCuffBot = cmToUV(rightCuffBotXcm, rightCuffBotYcm);

// Quadratic-bezier control points. Each control = chord midpoint + perpendicular
// offset (bow). Offsets computed in cm-equal space then converted back to UV
// (U and V have different physical scales).
const cmOffsetToUV = (dxCm: number, dyCm: number) => ({
  u: dxCm / BODY_W_CM,
  v: dyCm / BODY_H_CM,
});

// Sleeve top edge — sleeve cap is convex. Bow ~3 cm perpendicular outward
// (CW rotation of the chord direction = (-sinθ, -cosθ) for left sleeve).
const SLEEVE_CAP_BOW_CM = 3;
const sleeveCapBow = cmOffsetToUV(-SLEEVE_CAP_BOW_CM * sSin, -SLEEVE_CAP_BOW_CM * sCos);
const leftSleeveTopCX = (leftCuffTop.u + SHOULDER_LEFT_U) / 2 + sleeveCapBow.u;
const leftSleeveTopCY = (leftCuffTop.v + SHOULDER_DROP_V) / 2 + sleeveCapBow.v;
const rightSleeveTopCX = (rightCuffTop.u + SHOULDER_RIGHT_U) / 2 - sleeveCapBow.u;
const rightSleeveTopCY = (rightCuffTop.v + SHOULDER_DROP_V) / 2 + sleeveCapBow.v;

// Shoulder seam — subtle ~1 cm upward bow toward the neck for a softer line.
const SHOULDER_SEAM_BOW_CM = 1;
const leftShoulderSeamCX = (SHOULDER_LEFT_U + NECK_LEFT_U) / 2;
const leftShoulderSeamCY = (SHOULDER_DROP_V + 0) / 2 - SHOULDER_SEAM_BOW_CM / BODY_H_CM;
const rightShoulderSeamCX = (SHOULDER_RIGHT_U + NECK_RIGHT_U) / 2;
const rightShoulderSeamCY = (SHOULDER_DROP_V + 0) / 2 - SHOULDER_SEAM_BOW_CM / BODY_H_CM;

// Underarm curve — cuff bottom up to armpit. Bows outward & downward.
const leftUnderarmCX = (leftCuffBot.u + 0) / 2 - 0.025;
const leftUnderarmCY = (leftCuffBot.v + ARMPIT_V) / 2 + 0.020;
const rightUnderarmCX = (rightCuffBot.u + 1) / 2 + 0.025;
const rightUnderarmCY = (rightCuffBot.v + ARMPIT_V) / 2 + 0.020;

// Hem — slight downward bow (1 cm) for a softer bottom line.
const HEM_BOW_V = 1 / BODY_H_CM;
const hemMidCX = (HEM_LEFT_U + HEM_RIGHT_U) / 2;
const hemMidCY = 1 + HEM_BOW_V;

// Side seams — body widens gently from chest to hem (slight outward bow).
const SIDE_BOW_CM = 0.5;
const sideBowU = SIDE_BOW_CM / BODY_W_CM;
const leftSideCX = 0 - sideBowU;
const leftSideCY = (ARMPIT_V + 1) / 2;
const rightSideCX = 1 + sideBowU;
const rightSideCY = (ARMPIT_V + 1) / 2;

const fmt = (n: number) => n.toFixed(4);

// Combined silhouette: body + 2 drooping sleeves merged into one closed path.
// Traced clockwise from left cuff top. All major segments are quadratic
// beziers for a soft, rounded look matching a printed t-shirt template.
export const SHIRT_OUTLINE_PATH_D = [
  `M${fmt(leftCuffTop.u)} ${fmt(leftCuffTop.v)}`,
  `Q ${fmt(leftSleeveTopCX)} ${fmt(leftSleeveTopCY)} ${fmt(SHOULDER_LEFT_U)} ${fmt(SHOULDER_DROP_V)}`,
  `Q ${fmt(leftShoulderSeamCX)} ${fmt(leftShoulderSeamCY)} ${fmt(NECK_LEFT_U)} 0`,
  `Q 0.5 ${fmt(NECK_DEPTH_BACK)} ${fmt(NECK_RIGHT_U)} 0`,
  `Q ${fmt(rightShoulderSeamCX)} ${fmt(rightShoulderSeamCY)} ${fmt(SHOULDER_RIGHT_U)} ${fmt(SHOULDER_DROP_V)}`,
  `Q ${fmt(rightSleeveTopCX)} ${fmt(rightSleeveTopCY)} ${fmt(rightCuffTop.u)} ${fmt(rightCuffTop.v)}`,
  `L ${fmt(rightCuffBot.u)} ${fmt(rightCuffBot.v)}`,
  `Q ${fmt(rightUnderarmCX)} ${fmt(rightUnderarmCY)} 1 ${fmt(ARMPIT_V)}`,
  `Q ${fmt(rightSideCX)} ${fmt(rightSideCY)} ${fmt(HEM_RIGHT_U)} 1`,
  `Q ${fmt(hemMidCX)} ${fmt(hemMidCY)} ${fmt(HEM_LEFT_U)} 1`,
  `Q ${fmt(leftSideCX)} ${fmt(leftSideCY)} 0 ${fmt(ARMPIT_V)}`,
  `Q ${fmt(leftUnderarmCX)} ${fmt(leftUnderarmCY)} ${fmt(leftCuffBot.u)} ${fmt(leftCuffBot.v)}`,
  `L ${fmt(leftCuffTop.u)} ${fmt(leftCuffTop.v)}`,
  'Z',
].join(' ');

// Inner front-neckline curve (deeper than the back). Drawn separately so both
// curves are visible — same look as a printed t-shirt template.
export const SHIRT_FRONT_NECK_PATH_D =
  `M${fmt(NECK_LEFT_U + 0.012)} 0` +
  ` Q 0.5 ${fmt(NECK_DEPTH_FRONT)} ${fmt(NECK_RIGHT_U - 0.012)} 0`;

// Bounds the silhouette occupies — used to size the editor viewport.
export const SHIRT_OUTLINE_BOUNDS = {
  minU: leftCuffTop.u,
  maxU: rightCuffTop.u,
  minV: 0,
  maxV: 1,
};
