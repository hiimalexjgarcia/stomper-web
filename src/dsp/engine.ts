/**
 * Engine initialisation — port of FUN_004081F0.
 *
 *   void FUN_004081F0(int slots, int rate, int count, int *maxLen, double k1, double k2)
 *
 * The original walks the oscillator slots and fills the derived half of every
 * slot (+0x288 .. +0x2CC): envelope bounds in samples, phase increment and its
 * glide delta, the amplitude delta, and the unison ("chained to previous")
 * flag.
 */

import type { OscModel, OscState } from '../model/types.ts';
import { nextRandom, RNG_SEED, toSigned } from './noise.ts';

/**
 * The binary's own 2π constant, taken verbatim from 0x00437788.
 *
 * It is *not* the correctly rounded 2π (6.283185307179586): the original stores
 * the truncated 6.2831852.  The difference is only 1.7e-8 relative, but the
 * sine phase accumulates it over thousands of samples, which is visible in the
 * last few bits of a long render.  Using the binary's constant keeps exported
 * WAVs closer to the reference.
 */
export const TWO_PI = 6.2831852;

/** Everything the mixer needs, in a structure that survives structuredClone(). */
export interface DspContext {
  model: OscModel[];
  state: OscState[];
  count: number;
  /** Effective render rate (the device rate for live playback, the song rate for export). */
  rate: number;
  /** Longest envelope end, in samples — the length of the render. */
  maxLen: number;
  /** Decoded mono PCM for waveForm 4 oscillators (null when unresolved). */
  wav: (Float32Array | null)[];
  /** MSVC `_rand()` state (the LCG's `holdrand`). */
  rng: number;
  /** Noise value currently in use, per oscillator (re-rolled on NoiseChangeRate). */
  noise: number[];
  /** Per-oscillator noise counter (+0x2C8). */
  noiseCounter: number[];
}

export function createState(): OscState {
  return {
    envStart: 0,
    envEnd: 0,
    envLen: 0,
    phaseInc: 0,
    phaseIncDelta: 0,
    ampDelta: 0,
    phaseAcc: 0,
    filterState: 0,
    noiseOffset: 0,
    lastOut: 0,
    noiseCounter: 0,
    chained: false,
  };
}

export function prepareEngine(
  model: OscModel[],
  rate: number,
  wav: (Float32Array | null)[] = [],
  k1 = 1,
  k2 = 1,
): DspContext {
  const state: OscState[] = [];
  const noise: number[] = [];
  const noiseCounter: number[] = [];
  let maxLen = 0;

  for (let i = 0; i < model.length; i++) {
    const S = model[i];
    const st = createState();

    // ms -> samples, in the original's exact operation order:
    //    trunc(rate * StartT * 0.001)
    st.envStart = Math.trunc(rate * S.startT * 0.001);
    st.envEnd = Math.trunc(rate * S.endT * 0.001);
    st.envLen = st.envEnd - st.envStart;
    st.ampDelta = S.endA - S.startA;

    if (S.role === 0) {
      // Oscillator: phase increment = f / rate.  The sine waveform keeps the
      // phase in radians, every other waveform in cycles.
      const inc = (k1 * S.startF) / rate;
      const incEnd = (k1 * S.endF) / rate;
      st.phaseInc = S.waveForm === 0 ? inc * TWO_PI : inc;
      const end = S.waveForm === 0 ? incEnd * TWO_PI : incEnd;
      st.phaseIncDelta = end - st.phaseInc;
    } else {
      // Filter: one-pole coefficient with the original's normalisation.
      // The binary performs an integer division before multiplying:
      //   norm = (rate / 10000) * rate
      const norm = Math.trunc(rate / 10000) * rate;
      const inc = (k2 * S.startF * 2) / norm;
      const incEnd = (k2 * S.endF * 2) / norm;
      st.phaseInc = inc;
      st.phaseIncDelta = incEnd - inc;
    }

    // Chained voice: the previous slot's envelope ends exactly where this one
    // starts and both slots have the same role.  FUN_004081F0 sets +0x2CC
    // when `prev.envEnd == this.envStart`.
    if (i > 0) {
      const prev = state[i - 1];
      if (prev.envEnd === st.envStart && model[i - 1].role === S.role) st.chained = true;
    }

    if (st.envEnd > maxLen && S.enabled !== 0) maxLen = st.envEnd;

    state.push(st);
    noise.push(0);
    noiseCounter.push(0);
  }

  return {
    model,
    state,
    count: model.length,
    rate,
    maxLen,
    wav,
    rng: RNG_SEED,
    noise,
    noiseCounter,
  };
}

/**
 * Draw one noise sample in [-1, 1] from the generator carried by the context
 * (the original called the CRT RNG through FUN_00407FD0).
 */
export function drawNoise(ctx: DspContext): number {
  const r = nextRandom(ctx.rng);
  ctx.rng = r.state;
  return toSigned(r.value);
}
