/**
 * Live playback.
 *
 * The original rendered the whole song to a temporary .wav and called
 * PlaySoundA(SND_ASYNC) (FUN_004043B0).  The browser can do better: the same
 * engine runs inside an AudioWorklet, so previewing is instantaneous.
 *
 * Sample rate note: in the binary `rate` was both the device rate and the DSP
 * rate.  A browser AudioContext rate is fixed, so live playback substitutes the
 * device rate into both formulas (envStart = StartT * rate / 1000 and
 * phaseInc = f / rate); pitch and timing stay correct and the export path
 * keeps the original's exact numbers.
 */

import workletUrl from './worklet.ts?worker&url';
import { prepareEngine, type DspContext } from '../dsp/engine.ts';
import type { OscModel } from '../model/types.ts';
import { renderSongSync } from './renderSync.ts';

/**
 * Every AudioContext owns its own worklet global scope, so the module has to
 * be added once per context (not once per page).
 */
const loadedScopes = new WeakSet<BaseAudioContext>();

/** True when the context can host an AudioWorklet. */
export function supportsWorklet(scope: BaseAudioContext): boolean {
  return Boolean(scope.audioWorklet);
}

/** Add the engine module to a worklet scope exactly once per scope. */
export async function ensureEngineModule(scope: BaseAudioContext): Promise<void> {
  if (!scope.audioWorklet) {
    throw new Error(
      'AudioWorklet is unavailable in this context — serve the app over https:// or http://localhost.',
    );
  }
  if (loadedScopes.has(scope)) return;
  await scope.audioWorklet.addModule(workletUrl);
  loadedScopes.add(scope);
}

export class Playback {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private dsp: DspContext | null = null;
  /** Called when fallback playback finishes naturally. */
  onended: (() => void) | null = null;

  /** True when the fallback renderer is used (no AudioWorklet available). */
  fallback = false;

  get context(): AudioContext | null {
    return this.ctx;
  }

  get running(): boolean {
    return this.node !== null || this.source !== null;
  }

  /** Start (or restart) playback of the given song. */
  async start(model: OscModel[], wav: (Float32Array | null)[]): Promise<void> {
    await this.stop();

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    if (!ctx.audioWorklet) {
      // No AudioWorklet (it is [SecureContext] gated): render the song in the
      // main thread and play the resulting buffer.
      this.fallback = true;
      await this.startWithoutWorklet(ctx, model, wav);
      return;
    }

    this.fallback = false;
    await ensureEngineModule(ctx);

    // Live playback runs at the device rate.
    const dsp = prepareEngine(model, ctx.sampleRate, wav);
    this.dsp = dsp;

    const node = new AudioWorkletNode(ctx, 'stomper-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ctx: dsp },
    });
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string };
      if (data?.type === 'ended' && this.node === node) {
        this.node = null;
        this.onended?.();
      }
    };
    node.connect(ctx.destination);
    node.port.postMessage({ ctx: dsp, reset: true });
    this.node = node;
  }

  /** Fallback playback: render offline in the main thread, then play it. */
  private async startWithoutWorklet(
    ctx: AudioContext,
    model: OscModel[],
    wav: (Float32Array | null)[],
  ): Promise<void> {
    const result = renderSongSync(model, ctx.sampleRate, wav);
    const buffer = ctx.createBuffer(1, result.frames, ctx.sampleRate);
    buffer.getChannelData(0).set(result.samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
      }
      this.onended?.();
    };
    source.start();
    this.source = source;
  }

  /** Push a model change into the running engine without interrupting it. */
  update(model: OscModel[], wav: (Float32Array | null)[]): void {
    if (!this.ctx || !this.node) return; // the fallback plays a fixed buffer
    const dsp = prepareEngine(model, this.ctx.sampleRate, wav);
    this.dsp = dsp;
    this.node.port.postMessage({ ctx: dsp });
  }

  async stop(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.onended = null;
      this.source.disconnect();
      this.source = null;
    }
    this.dsp = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close().catch(() => undefined);
    }
  }
}
