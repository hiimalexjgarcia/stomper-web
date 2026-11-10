/**
 * The Stomper engine as an AudioWorkletProcessor.
 *
 * The whole synthesizer lives in here because the original mixer
 * (FUN_004083B0) is a sequential, order-dependent loop over the oscillator
 * list that mutates one shared accumulator.  That cannot be expressed with a
 * parallel WebAudio node graph.
 */

import type { DspContext } from '../dsp/engine.ts';
import { mixSample } from '../dsp/mixer.ts';

class StomperProcessor extends AudioWorkletProcessor {
  private ctx: DspContext | null = null;
  /**
   * Frame counter of this processor.
   *
   * The specification used to expose a `sampleIndex` global, but it was
   * dropped and Chrome never implemented it, so the worklet keeps its own
   * counter.  It starts at zero when the processor is created, which makes it
   * the song's own frame index — exactly what the mixer expects.
   */
  private frame = 0;
  private ended = false;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const initial = (options?.processorOptions as { ctx?: DspContext } | undefined)?.ctx;
    if (initial) this.ctx = initial;
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { ctx?: DspContext; reset?: boolean };
      if (data && data.ctx) {
        this.ctx = data.ctx;
        if (data.reset) {
          this.frame = 0;
          this.ended = false;
        }
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const ctx = this.ctx;
    if (!ctx) {
      output.fill(0);
      return true;
    }

    const base = this.frame;
    if (ctx.maxLen <= 0 || base >= ctx.maxLen) {
      output.fill(0);
      if (!this.ended) {
        this.ended = true;
        this.port.postMessage({ type: 'ended' });
      }
      return true;
    }

    const remaining = Math.min(output.length, ctx.maxLen - base);
    for (let n = 0; n < remaining; n++) {
      output[n] = mixSample(ctx, base + n);
    }
    if (remaining < output.length) {
      output.fill(0, remaining);
    }
    this.frame = base + output.length;

    if (this.frame >= ctx.maxLen && !this.ended) {
      this.ended = true;
      this.port.postMessage({ type: 'ended' });
    }
    return true;
  }
}

registerProcessor('stomper-processor', StomperProcessor);
