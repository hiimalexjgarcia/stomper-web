/**
 * Mixer — port of FUN_004083B0.
 *
 *   void FUN_004083B0(double *mix, int frames, int *sampleIndex, int count, int slots)
 *
 * The original walks the oscillator list for every output sample and mutates a
 * single running accumulator.  Filters read and write that accumulator, so the
 * order of the list is part of the sound: slot *i* filters what slots 0..i-1
 * produced and an oscillator's contribution is summed in list order.  A parallel
 * node graph could not reproduce this, which is why the whole engine lives in
 * one AudioWorkletProcessor.
 */

import type { DspContext } from './engine.ts';
import { drawNoise } from './engine.ts';
import { waveform } from './waveform.ts';

/**
 * Render one output sample.
 *
 * @param ctx  prepared engine state
 * @param idx  absolute sample index
 */
export function mixSample(ctx: DspContext, idx: number): number {
  let mix = 0;

  for (let i = 0; i < ctx.count; i++) {
    const S = ctx.model[i]!;
    const st = ctx.state[i]!;

    if (S.enabled === 0) continue; // Off
    if (idx < st.envStart || idx >= st.envEnd) continue; // outside the envelope

    if (st.chained) {
      // The original chains a slot to the previous one when the previous
      // envelope ends exactly where this one starts.  Phase and last output
      // are inherited once, so the two slots sound like one continuous voice.
      st.chained = false;
      const prev = ctx.state[i - 1]!;
      // +0x2B0 is one field in the original: phase for an oscillator, filter
      // memory for a filter.  Both slots have the same role.
      if (S.role === 0) st.phaseAcc = prev.phaseAcc;
      else st.filterState = prev.filterState;
      st.lastOut = prev.lastOut;
    }

    const t = (idx - st.envStart) / (st.envLen || 1);
    const tf = Math.pow(t, S.curveShape0); // timing curve   (+0x240)
    const ta = Math.pow(t, S.curveShape1); // amplitude curve (+0x248)

    let amp = S.startA + ta * st.ampDelta;
    let phase = st.phaseInc + tf * st.phaseIncDelta + st.noiseOffset;

    // Frequency modulation (+0x270/+0x280).  The factor scales the current
    // phase multiplicatively; a negative factor negates the whole term.
    if (S.fmSource >= 0) {
      const src = S.fmSource < ctx.count ? ctx.state[S.fmSource]!.lastOut : 0;
      if (S.fmModFac >= 0) phase = phase * src * S.fmModFac + phase;
      else phase = -(phase * src * S.fmModFac);
    }

    // Amplitude modulation (+0x278/+0x284), same multiplicative rule.
    if (S.amModBy >= 0) {
      const src = S.amModBy < ctx.count ? ctx.state[S.amModBy]!.lastOut : 0;
      if (S.amModFac >= 0) amp = amp * src * S.amModFac + amp;
      else amp = -(amp * src * S.amModFac);
    }

    if (S.role === 0) {
      // ---------------- oscillator ----------------
      st.phaseAcc += phase;
      const sample = waveform(ctx, i, st.phaseAcc) * amp;

      // Enabled == 1 is audible; Enabled == 2 ("Inaudible") still modulates
      // other slots but contributes nothing to the mix.
      if (S.enabled === 1) mix += sample;

      if (S.noiseBW > 0) {
        if (S.noiseChangeRate === 0) {
          // Re-roll whenever the waveform changes sign.
          if (sample * st.lastOut < 0) {
            st.noiseOffset = drawNoise(ctx) * S.noiseBW * phase;
          }
        } else {
          // Otherwise re-roll every NoiseChangeRate + 1 active samples.
          st.noiseCounter += 1;
          if (S.noiseChangeRate < st.noiseCounter) {
            st.noiseOffset = drawNoise(ctx) * S.noiseBW * phase;
            st.noiseCounter = 0;
          }
        }
      }

      st.lastOut = sample;
    } else {
      // ---------------- filter (one-pole over the running mix) ----------------
      const next = amp * st.filterState + (mix - st.lastOut) * phase;
      st.filterState = next;
      st.lastOut = next + st.lastOut;

      // Enabled == 1 replaces the running mix; Enabled == 2 only advances the
      // filter state and stays silent.
      if (S.enabled === 1) mix = st.lastOut;
    }
  }

  return mix;
}
