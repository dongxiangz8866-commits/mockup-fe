import { POSE_INDEX, type PoseLandmark } from '../poseDetector';
import { PRINT_ASPECT, PRINT_W_UV } from '../modelAssets';
import { type Pt, type Quad } from './types';

// Calibration constants. Print width is a fixed fraction of shoulder
// span (the cloth extends past landmark shoulders by SHOULDER_SPAN_OF_CLOTH_W;
// drives off PRINT_W_UV so 3D / UV editor / photos stay in sync).
const SHOULDER_SPAN_OF_CLOTH_W = 0.85;
const PRINT_W_FRAC = PRINT_W_UV / SHOULDER_SPAN_OF_CLOTH_W;

// Distance from midshoulder to print top, measured along the body
// vertical (perpendicular to the shoulder line) in fractions of
// shoulderLen. Iterated 0.35 → 0.22 → 0.10. MediaPipe Pose Lite places
// shoulder landmarks on the trapezius (~10–15 px above the visual
// shoulder edge), and that bias compounds with PRINT_DESCENT to drop
// the print into upper abdomen on standing fashion shots. 0.10 puts
// the print top at upper chest right below the collar, matching
// catalog product photography. Severely-leaning poses needing manual
// adjustment use whole-quad drag.
const PRINT_DESCENT = 0.10;

// Tilt-driven lateral offset gain — how much the print shifts in the
// lean direction per unit tilt. Empirical scale: 1.0 means at 10° tilt
// the print shifts by sin(10°) × shoulderLen ≈ 17% of shoulderLen
// (~40 px on a 250 px shoulder span). Dial down if the print
// over-shoots, up if lean tracking feels too subtle.
const TILT_OFFSET_GAIN = 1.0;

// SHOULDER-ONLY pose-to-quad. Iteration history:
//   1. Shoulder + hip angle average (original): noisy when one hip
//      occluded (hand-on-hip).
//   2. Spine-perp (mid-shoulder → mid-hip rotated 90°): captured lean
//      but drifted under bad hip landmarks.
//   3. Visibility-weighted spine-perp: INVENTED fake leans because
//      weighting biased midhip toward the visible side on a symmetric
//      body, making the print drift off-chest on hand-on-hip poses.
//   4. (This) Shoulder-only with tilt-driven offset. Drop hip entirely
//      since it's unreliable in practical fashion poses. Use shoulder
//      midpoint as anchor, shoulder-line angle as tilt, and add an
//      explicit lateral offset proportional to sin(tilt) so the print
//      tracks the lean direction without needing hip data.
export function quadFromLandmarks(lm: PoseLandmark[], w: number, h: number): Quad {
  const ls = lm[POSE_INDEX.leftShoulder];
  const rs = lm[POSE_INDEX.rightShoulder];
  const leftShoulder: Pt = { x: ls.x * w, y: ls.y * h };
  const rightShoulder: Pt = { x: rs.x * w, y: rs.y * h };

  const midshoulder: Pt = {
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

  // Body vertical = perpendicular to shoulder line, pointing into the
  // body (positive y in screen y-down for level shoulders).
  // For shoulderAngle α: shoulder direction is (cos α, sin α);
  // perpendicular into body is (−sin α, cos α).
  const bodyDownX = -Math.sin(shoulderAngle);
  const bodyDownY = Math.cos(shoulderAngle);

  // Base anchor: midshoulder + body-vertical descent by PRINT_DESCENT
  // fraction of shoulderLen. For a leaning body this naturally tilts
  // the descent direction so the anchor follows the body's orientation.
  const descent = shoulderLen * PRINT_DESCENT;
  const baseAnchorX = midshoulder.x + bodyDownX * descent;
  const baseAnchorY = midshoulder.y + bodyDownY * descent;

  // Tilt-driven lateral offset. sin(α) > 0 when shoulderAngle is
  // positive (left shoulder lower than right in screen y-down = body
  // leaning toward screen-right). Add a horizontal X shift proportional
  // to sin(α) × shoulderLen so the print moves in the lean direction.
  //   Level shoulders: sin(0) = 0 → no extra shift, print at midshoulder.x.
  //   Body leans screen-right (shoulderAngle > 0): print shifts right.
  //   Body leans screen-left (shoulderAngle < 0): print shifts left.
  // This matches the user's "body leans right → pattern shifts right"
  // mental model regardless of which side is interpreted as "right".
  const tiltOffset = Math.sin(shoulderAngle) * shoulderLen * TILT_OFFSET_GAIN;
  const printTop: Pt = {
    x: baseAnchorX + tiltOffset,
    y: baseAnchorY,
  };

  const tiltAngle = shoulderAngle;
  const halfW = shoulderLen * 0.5 * PRINT_W_FRAC;
  const halfX = Math.cos(tiltAngle) * halfW;
  const halfY = Math.sin(tiltAngle) * halfW;

  const printedW = halfW * 2;
  const printedH = printedW / PRINT_ASPECT;
  const offDownX = -Math.sin(tiltAngle) * printedH;
  const offDownY = Math.cos(tiltAngle) * printedH;

  return {
    tl: { x: printTop.x - halfX, y: printTop.y - halfY },
    tr: { x: printTop.x + halfX, y: printTop.y + halfY },
    bl: { x: printTop.x - halfX + offDownX, y: printTop.y - halfY + offDownY },
    br: { x: printTop.x + halfX + offDownX, y: printTop.y + halfY + offDownY },
  };
}
