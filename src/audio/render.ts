/**
 * Offline rendering — the browser equivalent of FUN_004087F0.
 *
 * The original rendered the song to a .wav file at the selected sample rate.
 * Here an OfflineAudioContext renders the very same engine at the very same
 * rate, which makes the export numerically identical to the desktop app.
 */

import { prepareEngine } from '../dsp/engine.ts';
import type { OscModel } from '../model/types.ts';
import { renderSongSync, type RenderResult } from './renderSync.ts';
import { ensureEngineModule } from './session.ts';

export type { RenderResult } from './renderSync.ts';

export async function renderSong(
  model: OscModel[],
  rate: number,
  wav: (Float32Array | null)[] = [],
): Promise<RenderResult> {
  // The engine knows how long the song is (FUN_004081F0 computes maxLen).
  const probe = prepareEngine(model, rate, wav);
  const frames = Math.max(1, probe.maxLen);

  const ctx = new OfflineAudioContext(1, frames, rate);
  if (!ctx.audioWorklet) {
    // No AudioWorklet in this context (it is [SecureContext] gated): render
    // the identical engine loop in the main thread instead.
    return renderSongSync(model, rate, wav);
  }
  await ensureEngineModule(ctx);

  const dsp = prepareEngine(model, rate, wav);
  const node = new AudioWorkletNode(ctx, 'stomper-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { ctx: dsp },
  });
  node.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  const samples = rendered.getChannelData(0).slice();

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }

  return { samples, peak, frames, rate };
}

/**
 * Port of FUN_00406A70 (Normalize): render, find the peak and divide the
 * amplitudes of every audible oscillator by it.
 */
export async function normalizeSong(model: OscModel[], rate: number, wav: (Float32Array | null)[]): Promise<RenderResult> {
  const result = await renderSong(model, rate, wav);
  if (result.peak > 0) {
    for (const o of model) {
      if (o.enabled === 1 && o.role === 0) {
        o.startA /= result.peak;
        o.endA /= result.peak;
      }
    }
  }
  return result;
}
