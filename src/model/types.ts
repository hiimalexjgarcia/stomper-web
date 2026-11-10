/**
 * Data model for Stomper Hyperion.
 *
 * Field names and semantics were recovered from STOMPER32.EXE (see
 * docs/references/STOMPER32-analysis.md).  The comments carry the byte offsets of the original
 * 0x308-byte oscillator slot so the two implementations can be diffed by eye.
 *
 *   FUN_00407470  INI loader   -> model below (persistent part of the slot)
 *   FUN_004081F0  engine init  -> derived part (see dsp/engine.ts)
 *   FUN_004083B0  mixer        -> consumes both
 */

export const MAX_OSC = 64; // FUN_00407470 clamps the oscillator count to 64
export const SLOT_STRIDE = 0x308; // bytes per oscillator slot

/** +0x25C */
export type Enabled = 0 | 1 | 2; // 0 = Off, 1 = On, 2 = Inaudible (modulator only)
/** +0x264 */
export type Role = 0 | 1 | 2; // 0 = oscillator, 1/2 = filter
/** +0x268 */
export type WaveForm = 0 | 1 | 2 | 3 | 4; // sine, triangle, square/random, saw, wav

// The names follow the shapes FUN_00407DB0 actually produces:
//   0 sine, 1 falling ramp, 2 square (duty cycle from CurveShape2),
//   3 triangle, 4 decoded WAV file.
export const WAVE_NAMES = ['Sine', 'Saw', 'Square', 'Triangle', 'WAV file'] as const;
export const ROLE_NAMES = ['Oscillator', 'Filter 1', 'Filter 2'] as const;
export const ENABLED_NAMES = ['Off', 'On', 'Inaudible'] as const;

/** Persistent, INI-serialisable part of one oscillator slot (+0x000 .. +0x284). */
export interface OscModel {
  wavFile: string; // +0x000  char[250] – path of the sample used by waveForm 4
  comment: string; // +0x100  char[250]
  startT: number; // +0x208  start time, milliseconds
  endT: number; // +0x210  end time, milliseconds
  startF: number; // +0x218  start frequency, Hz
  endF: number; // +0x220  end frequency, Hz
  startA: number; // +0x228  start amplitude
  endA: number; // +0x230  end amplitude
  noiseBW: number; // +0x238  noise bandwidth
  curveShape0: number; // +0x240  timing-curve exponent     pow(t, cs0)
  curveShape1: number; // +0x248  amplitude-curve exponent   pow(t, cs1)
  curveShape2: number; // +0x250  waveform-curve exponent    sign(v)*|v|^cs2
  noiseChangeRate: number; // +0x258
  enabled: Enabled; // +0x25C
  role: Role; // +0x264
  waveForm: WaveForm; // +0x268
  loopWav: number; // +0x26C
  fmModFac: number; // +0x270
  amModFac: number; // +0x278
  fmModBy: number; // +0x27C  INI "FMModBy"
  fmSource: number; // +0x280  index the mixer actually reads (-1 = none)
  amModBy: number; // +0x284  INI "AMModBy"
}

/**
 * A brand new slot, using the defaults baked into FUN_00407470.
 * The original uses StartF=2000, StartA=1, StartT=EndT=200 and the default
 * curve exponents 0.1 / 10 / 1.
 */
export function createOsc(overrides: Partial<OscModel> = {}): OscModel {
  return {
    wavFile: '',
    comment: '',
    startT: 200,
    endT: 200,
    startF: 2000,
    endF: 0,
    startA: 1,
    endA: 0,
    noiseBW: 0.1,
    curveShape0: 0.1,
    curveShape1: 10,
    curveShape2: 1,
    noiseChangeRate: 1,
    enabled: 1,
    role: 0,
    waveForm: 0,
    loopWav: 0,
    fmModFac: 0,
    amModFac: 0,
    fmModBy: -1,
    fmSource: -1,
    amModBy: -1,
    ...overrides,
  };
}

/**
 * Derived, per-oscillator state filled in by the engine initialiser
 * (FUN_004081F0).  It is never serialised.
 */
export interface OscState {
  /** +0x288 — envelope start, in samples */
  envStart: number;
  /** +0x28C — envelope end, in samples */
  envEnd: number;
  /** +0x290 — envelope length, in samples */
  envLen: number;
  /** +0x298 — phase increment (radians/sample for the sine) */
  phaseInc: number;
  /** +0x2A0 — difference between the end and start increment */
  phaseIncDelta: number;
  /** +0x2A8 — end amplitude minus start amplitude */
  ampDelta: number;
  /** +0x2B0 — running phase (oscillator) or filter memory (filter) */
  phaseAcc: number;
  /** +0x2B0 — filter memory; the original shares one slot with `phaseAcc` */
  filterState: number;
  /** +0x2B8 — noise offset added to the phase */
  noiseOffset: number;
  /** +0x2C0 — last output value (used by FM/AM) */
  lastOut: number;
  /** +0x2C8 — noise counter */
  noiseCounter: number;
  /** +0x2CC — "chained to previous slot" flag */
  chained: boolean;
}

export interface Song {
  /** dialog +0x9FC — 22050 | 44100 | 48000 */
  rate: number;
  oscillators: OscModel[];
  /** dialog +0x78 */
  filename: string;
  /** dialog +0x84 */
  dirty: boolean;
  /** dialog +0x85 */
  saved: boolean;
}

export function createSong(oscillators: OscModel[] = []): Song {
  return { rate: 48000, oscillators, filename: '', dirty: true, saved: false };
}

/** Deep copy of a slot list (the web equivalent of the 0x18400 byte undo blob). */
export function cloneOscillators(list: OscModel[]): OscModel[] {
  return list.map((o) => ({ ...o }));
}
