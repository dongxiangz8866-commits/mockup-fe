import { POSE_INDEX, type PoseLandmark } from '../poseDetector';
import { PRINT_ASPECT, PRINT_W_UV } from '../modelAssets';
import { type Pt, type Quad } from './types';

// Calibration constants. Print width is a fixed fraction of shoulder
// span (the cloth extends past landmark shoulders by SHOULDER_SPAN_OF_CLOTH_W;
// drives off PRINT_W_UV so 3D / UV editor / photos stay in sync).
const SHOULDER_SPAN_OF_CLOTH_W = 0.85;
const PRINT_W_FRAC = PRINT_W_UV / SHOULDER_SPAN_OF_CLOTH_W;
// Global size attenuation. 2026-05-20 user feedback: the spec-derived width
// looks oversized on actual photos — knock 15% off across the board. Applies
// to both shoulder-fallback and cloth-mask sizing paths.
const PRINT_SIZE_SCALE = 0.85;

// Distance from midshoulder to print top, measured along the body
// vertical (perpendicular to the shoulder line) in fractions of
// shoulderLen. Iterated 0.35 → 0.22 → 0.10 → 0.05. MediaPipe Pose Lite
// places shoulder landmarks on the trapezius (~10–15 px above the
// visual shoulder edge), and that bias compounds with PRINT_DESCENT to
// drop the print into upper abdomen on standing fashion shots. 0.05
// puts the print top right at the collar line — catalog-style high
// chest placement. Severely-leaning poses needing manual adjustment
// use whole-quad drag.
const PRINT_DESCENT = 0.05;

// Chest doesn't rotate 1:1 with shoulders — when shoulders tilt, the torso
// twists less and cloth on the chest barely rotates at all (the print sits
// on the chest, not on the shoulder yoke). Attenuate the shoulder angle
// before applying to print rotation + perpendicular axis so a 10° shoulder
// tilt visually rotates the print by ~4°. tiltOffset (lateral lean shift)
// still reads the FULL shoulderAngle since the lean direction signal isn't
// attenuated by anatomy — only the visible rotation of the artwork is.
const PRINT_TILT_ATTENUATION = 0.4;

// Tilt-driven lateral correction.
//   shoulderAngle ∈ (-π, π], computed from atan2(L.y - R.y, L.x - R.x).
//   For a forward-facing pose (L.x > R.x since L is MODEL's left = viewer
//   right), the angle is small and signed:
//     angle < 0  ⇔  L (viewer-right) shoulder HIGHER  ⇔  model leans
//                  to her right = TOWARD VIEWER'S LEFT
//     angle > 0  ⇔  R (viewer-left) shoulder HIGHER   ⇔  model leans
//                  to her left  = TOWARD VIEWER'S RIGHT
//   tiltOffset = shoulderAngle × shoulderLen × gain
//     positive gain → print shifts in the SAME direction as the lean
//                     (follows the body's lateral drift)
//     negative gain → print shifts against the lean (counter-tilt)
//   Single signed scalar handles both lean directions automatically;
//   the slider in the UI just sets magnitude (and sign) of the correction.
export const TILT_OFFSET_GAIN_DEFAULT = 0.25;
// Lowered 0.65 → 0.30 (2026-05-20): on photos where the model's head turns
// off-axis while her torso faces forward, a 0.65 weight pulled the print
// noticeably toward the nose side (Image A: headShift dominated tiltOffset
// ~5×). 0.30 keeps the correction for genuinely off-center torsos but
// stops the print from chasing head turn.
const HEAD_CENTER_GAIN = 0.30;
const HEAD_CENTER_MAX_SHIFT = 0.28;

// SHOULDER-ONLY pose-to-quad. Iteration history:
//   1. Shoulder + hip angle average (original): noisy when one hip
//      occluded (hand-on-hip).
//   2. Spine-perp (mid-shoulder → mid-hip rotated 90°): captured lean
//      but drifted under bad hip landmarks.
//   3. Visibility-weighted spine-perp: INVENTED fake leans because
//      weighting biased midhip toward the visible side on a symmetric
//      body, making the print drift off-chest on hand-on-hip poses.
//   4. Shoulder-only with tilt-driven offset. Drop hip entirely
//      since it's unreliable in practical fashion poses. Use shoulder
//      midpoint as anchor, shoulder-line angle as tilt, and add an
//      explicit lateral offset proportional to sin(tilt) so the print
//      tracks the lean direction without needing hip data.
//   5. Head-center correction. Hips were too unstable on cropped /
//      hair-occluded fashion shots, while shoulder midpoint can be biased by
//      hair / sleeve width. Use nose X as a capped correction toward the
//      visible upper-body center.
export function quadFromLandmarks(
  lm: PoseLandmark[],
  w: number,
  h: number,
  tiltOffsetGain: number = TILT_OFFSET_GAIN_DEFAULT,
  // Optional: override the size base used for halfW. Pass the measured cloth
  // mask width at chest level here so the print scales with the SHIRT, not
  // with shoulder span (matters for oversized/loose tees where the cloth is
  // visibly wider than the shoulder landmarks suggest). Falls back to
  // shoulderLen when omitted, preserving prior behavior for callers that
  // don't measure cloth (e.g. useModelAssets / pre-mask-ready first render).
  widthOverride?: number,
): Quad {
  const nose = lm[POSE_INDEX.nose];
  const ls = lm[POSE_INDEX.leftShoulder];
  const rs = lm[POSE_INDEX.rightShoulder];
  const headX = nose ? nose.x * w : null;
  const leftShoulder: Pt = { x: ls.x * w, y: ls.y * h };
  const rightShoulder: Pt = { x: rs.x * w, y: rs.y * h };

  const rawMidshoulder: Pt = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };

  const shoulderAngle = Math.atan2(
    leftShoulder.y - rightShoulder.y,
    leftShoulder.x - rightShoulder.x
  );

  const shoulderLen = Math.hypot(
    leftShoulder.x - rightShoulder.x,
    leftShoulder.y - rightShoulder.y
  );
  const headShift = headX === null
    ? 0
    : Math.max(
      -shoulderLen * HEAD_CENTER_MAX_SHIFT,
      Math.min(shoulderLen * HEAD_CENTER_MAX_SHIFT, (headX - rawMidshoulder.x) * HEAD_CENTER_GAIN)
    );
  const midshoulder: Pt = {
    x: rawMidshoulder.x + headShift,
    y: rawMidshoulder.y,
  };

  // Attenuated: the print rotates less than the shoulders (see PRINT_TILT_ATTENUATION).
  const tiltAngle = shoulderAngle * PRINT_TILT_ATTENUATION;
  // Cloth-measured width preferred (oversized tees), shoulder span as fallback.
  // widthOverride is raw cloth-mask pixels; scale by SHOULDER_SPAN_OF_CLOTH_W
  // so PRINT_W_FRAC (which was calibrated against shoulder span) produces
  // print_width = clothWidth × PRINT_W_UV — a constant fraction of the GARMENT
  // regardless of fit (fitted vs oversized tee).
  // 2026-05-20: cap at 1.15× shoulderLen. Oversized cloth widths can run
  // 1.4–1.6× shoulder span; without a cap the print spills past the shoulder
  // landmark onto the upper-arm/hair region — SkSL occl=1-hair then削掉
  // 那块 print → 透出 photo 原色,黑发模特上呈现为印图矩形左/右下角的"黑块"。
  // 1.15× lets oversized still print bigger than fitted while staying inside
  // shoulder territory.
  const rawSizeBase = widthOverride && widthOverride > 0
    ? widthOverride * SHOULDER_SPAN_OF_CLOTH_W
    : shoulderLen;
  const sizeBase = Math.min(rawSizeBase, shoulderLen * 1.15);
  const halfW = sizeBase * 0.5 * PRINT_W_FRAC * PRINT_SIZE_SCALE;
  const halfX = Math.cos(tiltAngle) * halfW;
  const halfY = Math.sin(tiltAngle) * halfW;

  const printedW = halfW * 2;
  const printedH = printedW / PRINT_ASPECT;
  // Print's "down" axis perpendicular to its top edge — uses the SAME
  // attenuated angle so the rectangle stays rigid (top and side remain
  // perpendicular). If we mixed attenuated top with full-angle side, the
  // print would skew into a parallelogram.
  const bodyDownX = -Math.sin(tiltAngle);
  const bodyDownY = Math.cos(tiltAngle);
  const offDownX = bodyDownX * printedH;
  const offDownY = bodyDownY * printedH;
  const descent = shoulderLen * PRINT_DESCENT;
  // Signed lean: positive ⇔ lean→viewer-right, negative ⇔ lean→viewer-left.
  // Multiplied by shoulderLen for size scaling and gain for tuning. For
  // small angles equivalent to sin(angle) * shoulderLen * gain, but written
  // with angle directly so the sign intent is self-evident.
  const tiltOffset = shoulderAngle * shoulderLen * tiltOffsetGain;
  const printTop: Pt = {
    x: midshoulder.x + bodyDownX * descent + tiltOffset,
    y: midshoulder.y + bodyDownY * descent,
  };

  return {
    tl: { x: printTop.x - halfX, y: printTop.y - halfY },
    tr: { x: printTop.x + halfX, y: printTop.y + halfY },
    bl: { x: printTop.x - halfX + offDownX, y: printTop.y - halfY + offDownY },
    br: { x: printTop.x + halfX + offDownX, y: printTop.y + halfY + offDownY },
  };
}
