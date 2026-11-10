/**
 * Waveform generator — port of FUN_00407DB0.
 *
 *   double FUN_00407DB0(int slot)
 *
 * The function switches on the waveform id (+0x268) through a jump table and
 * then shapes the result with CurveShape2 (+0x250):
 *
 *     v = sign(v) * |v| ^ cs2
 *
 * The original takes the absolute value, raises it and restores the sign —
 * the two fchs instructions cancel out.
 *
 * The fractional part of the phase is computed by the VB runtime helper
 * FUN_004132ae (Fix/Frnd) and subtracted from the phase:
 *
 *     x = phase - Fix(phase)
 *
 * which for a non-negative phase is exactly fmod(phase, 1).  Note that this is
 * *not* the same as `phase - fmod(phase, 1)` (that would be the integer part);
 * an earlier decompilation of this function mis-rendered the helper call,
 * which is why the first version of this port produced garbage.
 */

import type { DspContext } from './engine.ts';

/**
 * The fractional part of the phase.
 *
 * fmod() semantics: the result keeps the sign of the dividend, exactly like
 * the JS remainder operator.  For a non-negative phase this is identical to
 * `phase - Math.trunc(phase)`.
 */
function frac(phase: number): number {
  return phase % 1;
}

export function waveform(ctx: DspContext, index: number, phase: number): number {
  const S = ctx.model[index];
  let v: number;

  switch (S.waveForm) {
    case 0: {
      // Sine; the phase is kept in radians for this waveform.
      v = Math.sin(phase);
      break;
    }
    case 1: {
      // Falling ramp: 1.0 - 2.0 * x
      v = 1 - 2 * frac(phase);
      break;
    }
    case 2: {
      // Square wave.  The duty cycle comes from CurveShape2: the fractional
      // part is raised to cs2 and compared against 0.5.
      v = Math.pow(frac(phase), S.curveShape2) > 0.5 ? 1 : -1;
      break;
    }
    case 3: {
      // Triangle: rises over the first quarter, falls over the middle half
      // and rises again over the last quarter.
      const x = frac(phase);
      if (x < 0.25) v = x * 4;
      else if (x <= 0.75) v = 1 - (x - 0.25) * 4;
      else v = (x - 0.75) * 4 - 1;
      break;
    }
    case 4: {
      // Decoded WAV frame.  The original truncates the phase to a frame index
      // without interpolating, and clamps or wraps depending on LoopWav.
      const pcm = ctx.wav[index];
      if (!pcm || pcm.length === 0) {
        v = 0;
        break;
      }
      const raw = Math.trunc(phase);
      const idx =
        S.loopWav === 0
          ? Math.min(Math.max(raw, 0), pcm.length - 1)
          : ((raw % pcm.length) + pcm.length) % pcm.length;
      v = pcm[idx]!;
      break;
    }
    default:
      v = phase;
      break;
  }

  // CurveShape2: sign(v) * |v|^cs2
  return v > 0 ? Math.pow(v, S.curveShape2) : -Math.pow(-v, S.curveShape2);
}
