/**
 * Pure-JavaScript rendering — the fallback for contexts without AudioWorklet.
 *
 * `BaseAudioContext.audioWorklet` is `[SecureContext]` gated: on a page that
 * is served over plain HTTP from anything but localhost the property is
 * simply missing, and `addModule()` cannot be called at all.  The same is
 * true for browsers that do not implement the AudioWorklet.
 *
 * The worklet does nothing but call `mixSample()` with the prepared engine, so
 * running the very same loop in the main thread produces identical samples —
 * the export stays bit-exact and playback stays in sync with the model.
 */

import { prepareEngine } from '../dsp/engine.ts';
import { mixSample } from '../dsp/mixer.ts';
import type { OscModel } from '../model/types.ts';

export interface RenderResult {
  samples: Float32Array;
  peak: number;
  frames: number;
  rate: number;
}

/** Render the whole song in the current thread. */
export function renderSongSync(
  model: OscModel[],
  rate: number,
  wav: (Float32Array | null)[] = [],
): RenderResult {
  const dsp = prepareEngine(model, rate, wav);
  const frames = Math.max(1, dsp.maxLen);
  const samples = new Float32Array(frames);

  let peak = 0;
  for (let i = 0; i < frames; i++) {
    samples[i] = mixSample(dsp, i);
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }

  return { samples, peak, frames, rate };
}
