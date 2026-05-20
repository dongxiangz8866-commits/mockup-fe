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
// shoulderLen. Iterated 0.35 → 0.22 → 0.10 → 0.05. MediaPipe Pose Lite
// places shoulder landmarks on the trapezius (~10–15 px above the
// visual shoulder edge), and that bias compounds with PRINT_DESCENT to
// drop the print into upper abdomen on standing fashion shots. 0.05
// puts the print top right at the collar line — catalog-style high
// chest placement. Severely-leaning poses needing manual adjustment
// use whole-quad drag.
const PRINT_DESCENT = 0.05;

// Tilt-driven lateral correction. Keep this deliberately conservative;
// head-center alignment handles the larger left/right shifts.
const TILT_OFFSET_GAIN = 0.25;
const HEAD_CENTER_GAIN = 0.65;
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
export function quadFromLandmarks(lm: PoseLandmark[], w: number, h: number): Quad {
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

  const tiltAngle = shoulderAngle;
  const halfW = shoulderLen * 0.5 * PRINT_W_FRAC;
  const halfX = Math.cos(tiltAngle) * halfW;
  const halfY = Math.sin(tiltAngle) * halfW;

  const printedW = halfW * 2;
  const printedH = printedW / PRINT_ASPECT;
  const bodyDownX = -Math.sin(shoulderAngle);
  const bodyDownY = Math.cos(shoulderAngle);
  const offDownX = bodyDownX * printedH;
  const offDownY = bodyDownY * printedH;
  const descent = shoulderLen * PRINT_DESCENT;
  const tiltOffset = bodyDownX * shoulderLen * TILT_OFFSET_GAIN;
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
