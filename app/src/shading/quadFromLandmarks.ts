import { POSE_INDEX, type PoseLandmark } from '../poseDetector';
import { PRINT_ASPECT, PRINT_V, PRINT_W_UV } from '../modelAssets';
import { lerpPt, type Pt, type Quad } from './types';

// Calibration of MediaPipe landmarks against the cloth, in normalized
// cloth-V units (V=0 at cloth top, V=1 at hem).
//
// MIDSHOULDER_CLOTH_V: MediaPipe's shoulder joints sit at the deltoid
//   attachment, ~5-7 cm below the cloth's top corner (which is the shoulder
//   seam). At cloth-center this is roughly the neckline level → V ≈ 0.10.
// MIDHIP_CLOTH_V:      The hem extends below the hip joint by ~6-8 cm on a
//   typical t-shirt → hip-joint at V ≈ 0.90.
// SHOULDER_SPAN_OF_CLOTH_W: the cloth extends past the shoulder joints out
//   to the sleeve attachment, so detected shoulder span is ~0.85× cloth W.
const MIDSHOULDER_CLOTH_V = 0.10;
const MIDHIP_CLOTH_V = 0.90;
const SHOULDER_SPAN_OF_CLOTH_W = 0.85;

const BODY_AXIS_CLOTH_V_RANGE = MIDHIP_CLOTH_V - MIDSHOULDER_CLOTH_V;
// Top-of-print position along the shoulder→hip axis (parametric t).
const PRINT_TOP_T = (PRINT_V - MIDSHOULDER_CLOTH_V) / BODY_AXIS_CLOTH_V_RANGE;
// Print width (cloth fraction) → fraction of shoulder span via calibration.
// Drives off PRINT_W_UV so 3D / UV editor / photos all stay in sync.
const PRINT_W_FRAC = PRINT_W_UV / SHOULDER_SPAN_OF_CLOTH_W;

export function quadFromLandmarks(lm: PoseLandmark[], w: number, h: number): Quad {
  const ls = lm[POSE_INDEX.leftShoulder];
  const rs = lm[POSE_INDEX.rightShoulder];
  const lh = lm[POSE_INDEX.leftHip];
  const rh = lm[POSE_INDEX.rightHip];
  const toPt = (p: PoseLandmark): Pt => ({ x: p.x * w, y: p.y * h });
  const leftShoulder = toPt(ls);
  const rightShoulder = toPt(rs);
  const leftHip = toPt(lh);
  const rightHip = toPt(rh);

  const topMid: Pt = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const botMid: Pt = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };

  const printTop = lerpPt(topMid, botMid, PRINT_TOP_T);

  const shoulderAngle = Math.atan2(
    leftShoulder.y - rightShoulder.y,
    leftShoulder.x - rightShoulder.x
  );
  const hipAngle = Math.atan2(
    leftHip.y - rightHip.y,
    leftHip.x - rightHip.x
  );
  const tiltAngle = (shoulderAngle + hipAngle) / 2;

  const shoulderLen = Math.hypot(
    leftShoulder.x - rightShoulder.x,
    leftShoulder.y - rightShoulder.y
  );
  const halfW = shoulderLen * 0.5 * PRINT_W_FRAC;
  const halfX = Math.cos(tiltAngle) * halfW;
  const halfY = Math.sin(tiltAngle) * halfW;

  const printedW = halfW * 2;
  const printedH = printedW / PRINT_ASPECT;
  const downX = -Math.sin(tiltAngle) * printedH;
  const downY = Math.cos(tiltAngle) * printedH;

  return {
    tl: { x: printTop.x - halfX, y: printTop.y - halfY },
    tr: { x: printTop.x + halfX, y: printTop.y + halfY },
    bl: { x: printTop.x - halfX + downX, y: printTop.y - halfY + downY },
    br: { x: printTop.x + halfX + downX, y: printTop.y + halfY + downY },
  };
}
