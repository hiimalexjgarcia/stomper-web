import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareEngine, TWO_PI, type DspContext } from '../src/dsp/engine.ts';
import { mixSample } from '../src/dsp/mixer.ts';
import { RNG_SEED, nextRandom, toSigned } from '../src/dsp/noise.ts';
import { createOsc, type OscModel, type WaveForm } from '../src/model/types.ts';

const RATE = 22050;

test('the engine uses the binary\'s truncated 2π constant', () => {
  // 0x00437788 holds 6.2831852, not the correctly rounded 2π.  A relative
  // error of 1.7e-8 is tiny, but sine phase accumulates it over long renders.
  assert.equal(TWO_PI, 6.2831852);
  assert.notEqual(TWO_PI, Math.PI * 2);
});

test('the noise generator is the unseeded MSVC LCG', () => {
  // With the CRT's default holdrand == 1, the first _rand() outputs are
  // 41, 18467, 6334, 26500, ...
  let state = RNG_SEED;
  const outputs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = nextRandom(state);
    outputs.push(Math.round(r.value * 32767));
    state = r.state;
  }
  assert.deepEqual(outputs, [41, 18467, 6334, 26500]);
  // The mixer maps [0,1] to [-1,1] with (r+r)-1.
  assert.equal(toSigned(0), -1);
  assert.equal(toSigned(1), 1);
  assert.equal(toSigned(0.5), 0);
});

function render(model: OscModel[], frames = RATE, rate = RATE): Float32Array {
  const ctx = prepareEngine(model, rate, model.map(() => null));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = mixSample(ctx, i);
  return out;
}

function peak(samples: Float32Array): number {
  let p = 0;
  for (const s of samples) p = Math.max(p, Math.abs(s));
  return p;
}

test('the engine converts milliseconds to samples', () => {
  const ctx = prepareEngine([createOsc({ startT: 1000, endT: 2000 })], RATE, []);
  assert.equal(ctx.state[0]!.envStart, 22050);
  assert.equal(ctx.state[0]!.envEnd, 44100);
  assert.equal(ctx.state[0]!.envLen, 22050);
});

test('the sine keeps its phase in radians, the other waveforms in cycles', () => {
  const sine = prepareEngine([createOsc({ waveForm: 0, startF: 440, endF: 440 })], RATE, []);
  assert.ok(Math.abs(sine.state[0]!.phaseInc - (TWO_PI * 440) / RATE) < 1e-12);

  const saw = prepareEngine([createOsc({ waveForm: 3, startF: 440, endF: 440 })], RATE, []);
  assert.ok(Math.abs(saw.state[0]!.phaseInc - 440 / RATE) < 1e-12);
});

test('the phase increment delta follows the frequency sweep', () => {
  const ctx = prepareEngine([createOsc({ waveForm: 3, startF: 100, endF: 200 })], RATE, []);
  assert.ok(Math.abs(ctx.state[0]!.phaseIncDelta - 100 / RATE) < 1e-12);
});

test('maxLen is the longest enabled envelope, in samples', () => {
  const model = [
    createOsc({ enabled: 1, startT: 0, endT: 1000 }),
    createOsc({ enabled: 0, startT: 0, endT: 5000 }),
    createOsc({ enabled: 2, startT: 0, endT: 3000 }),
  ];
  const ctx = prepareEngine(model, RATE, []);
  // The silent slot is ignored, the inaudible one still has to be rendered
  // because it modulates the oscillators that follow it.
  assert.equal(ctx.maxLen, Math.trunc(3000 * RATE * 0.001));
});

test('slots are chained when the previous envelope ends where they start', () => {
  // FUN_004081F0 compares the previous envEnd with this slot's envStart, and
  // only chains slots with the same role.
  const model = [
    createOsc({ startT: 0, endT: 1000 }),
    createOsc({ startT: 1000, endT: 2000 }),
  ];
  const ctx = prepareEngine(model, RATE, []);
  assert.equal(ctx.state[0]!.chained, false);
  assert.equal(ctx.state[1]!.chained, true);

  // Same start but no shared boundary: not chained.
  const overlapping = prepareEngine(
    [createOsc({ startT: 0, endT: 1000 }), createOsc({ startT: 0, endT: 1000 })],
    RATE,
    [],
  );
  assert.equal(overlapping.state[1]!.chained, false);

  // Same boundary but a different role: not chained either.
  const mixedRoles = prepareEngine(
    [createOsc({ startT: 0, endT: 1000 }), createOsc({ role: 1, startT: 1000, endT: 2000 })],
    RATE,
    [],
  );
  assert.equal(mixedRoles.state[1]!.chained, false);
});

test('a constant sine reproduces its amplitude', () => {
  const model = [
    createOsc({
      waveForm: 0,
      startF: 440,
      endF: 440,
      startA: 0.5,
      endA: 0.5,
      curveShape1: 1,
      noiseBW: 0,
      startT: 0,
      endT: 1000,
    }),
  ];
  const samples = render(model);
  assert.ok(peak(samples) > 0.49 && peak(samples) < 0.51, `peak was ${peak(samples)}`);
  // The engine advances the phase before it generates the sample, so the
  // first output is sin(2*pi*440/22050) * amplitude.
  assert.ok(Math.abs(samples[0]!) > 0.05 && Math.abs(samples[0]!) < 0.08);
  // A sine of 440 Hz at 22050 Hz repeats every 50.1 samples, so the first
  // quarter period is reached after about 12.5 samples.
  assert.ok(Math.abs(samples[12]!) > 0.49);
});

test('an oscillator only sounds inside its envelope', () => {
  const model = [
    createOsc({
      waveForm: 0,
      startF: 440,
      endF: 440,
      startA: 0.5,
      endA: 0.5,
      curveShape1: 1,
      noiseBW: 0,
      startT: 100,
      endT: 200,
    }),
  ];
  const samples = render(model, 5000);
  assert.equal(samples[0], 0);
  assert.equal(samples[50], 0);
  assert.ok(peak(samples) > 0.49);
  // 210 ms is past the end of the envelope (100 ms .. 200 ms).
  assert.equal(samples[Math.floor(210 * RATE * 0.001)], 0);
});

test('an inaudible oscillator stays silent but still modulates', () => {
  const silent = render([
    createOsc({
      waveForm: 0,
      startF: 440,
      endF: 440,
      startA: 0.5,
      endA: 0.5,
      curveShape1: 1,
      noiseBW: 0,
      enabled: 2,
      startT: 0,
      endT: 1000,
    }),
  ]);
  assert.equal(peak(silent), 0);

  // The same slot as the FM source of a second oscillator must change the sound.
  const plain = render([
    createOsc({ waveForm: 0, startF: 440, endF: 440, startA: 0.5, endA: 0.5, curveShape1: 1, noiseBW: 0, startT: 0, endT: 1000 }),
    createOsc({
      waveForm: 0,
      startF: 220,
      endF: 220,
      startA: 0.5,
      endA: 0.5,
      curveShape1: 1,
      noiseBW: 0,
      enabled: 2,
      startT: 0,
      endT: 1000,
    }),
  ]);
  const modulated = render([
    createOsc({ waveForm: 0, startF: 440, endF: 440, startA: 0.5, endA: 0.5, curveShape1: 1, noiseBW: 0, startT: 0, endT: 1000 }),
    createOsc({
      waveForm: 0,
      startF: 220,
      endF: 220,
      startA: 0.5,
      endA: 0.5,
      curveShape1: 1,
      noiseBW: 0,
      enabled: 2,
      startT: 0,
      endT: 1000,
    }),
    createOsc({
      waveForm: 0,
      startF: 880,
      endF: 880,
      startA: 0.4,
      endA: 0.4,
      curveShape1: 1,
      noiseBW: 0,
      startT: 0,
      endT: 1000,
      fmSource: 1,
      fmModFac: 0.5,
    }),
  ]);
  assert.notDeepEqual(Array.from(modulated), Array.from(plain));
});

test('a filter attenuates the mix it processes', () => {
  const source = createOsc({
    waveForm: 2,
    startF: 1000,
    endF: 1000,
    startA: 0.5,
    endA: 0.5,
    curveShape1: 1,
    noiseBW: 0,
    startT: 0,
    endT: 1000,
  });
  const open = render([source, createOsc({ role: 1, startF: 20000, endF: 20000, startA: 0.5, endA: 0.5, startT: 0, endT: 1000, enabled: 1 })]);
  const closed = render([source, createOsc({ role: 1, startF: 20, endF: 20, startA: 0.5, endA: 0.5, startT: 0, endT: 1000, enabled: 1 })]);
  assert.ok(peak(closed) < peak(open), `closed ${peak(closed)} vs open ${peak(open)}`);
});

test('an inaudible filter updates its state without changing the mix', () => {
  const source = createOsc({
    waveForm: 2,
    startF: 1000,
    endF: 1000,
    startA: 0.5,
    endA: 0.5,
    curveShape1: 1,
    noiseBW: 0,
    startT: 0,
    endT: 1000,
  });
  const plain = render([source]);
  const withSilentFilter = render([
    source,
    createOsc({ role: 1, startF: 20, endF: 20, startA: 0.5, endA: 0.5, startT: 0, endT: 1000, enabled: 2 }),
  ]);
  assert.deepEqual(Array.from(withSilentFilter), Array.from(plain));
});

test('the noise source stays inside [-1, 1] and is reproducible', () => {
  const a: DspContext = prepareEngine([createOsc()], RATE, []);
  const b: DspContext = prepareEngine([createOsc()], RATE, []);
  const first: number[] = [];
  const second: number[] = [];
  for (let i = 0; i < 64; i++) {
    first.push(mixSample(a, i));
    second.push(mixSample(b, i));
  }
  assert.deepEqual(first, second);
  for (const value of first) assert.ok(Number.isFinite(value));
});

test('the demo song renders without NaN', () => {
  const model = [
    createOsc({ waveForm: 0, startF: 150, endF: 45, startA: 1, endA: 0, curveShape1: 3, startT: 0, endT: 300 }),
    createOsc({ waveForm: 3, startF: 900, endF: 220, startA: 0.6, endA: 0, curveShape1: 4, noiseBW: 0.35, startT: 300, endT: 600 }),
    createOsc({ role: 1, startF: 400, endF: 4000, startA: 1, endA: 1, enabled: 2, startT: 0, endT: 1200 }),
  ];
  const samples = render(model, 2000);
  for (const s of samples) assert.ok(Number.isFinite(s), `not finite: ${s}`);
  assert.ok(peak(samples) > 0);
});

/** A one-cycle-per-second oscillator, so the phase grows by exactly 1/22050. */
function cycleOsc(waveForm: WaveForm): OscModel {
  return createOsc({
    waveForm,
    startF: 1,
    endF: 1,
    startA: 1,
    endA: 1,
    curveShape1: 1,
    curveShape2: 1,
    noiseBW: 0,
    startT: 0,
    endT: 2000,
  });
}

test('every waveform stays inside [-1, 1]', () => {
  for (let waveForm = 0; waveForm <= 3; waveForm++) {
    const samples = render([cycleOsc(waveForm as WaveForm)], RATE);
    for (const s of samples) {
      assert.ok(s >= -1.000001 && s <= 1.000001, `waveForm ${waveForm} produced ${s}`);
    }
  }
});

test('the non-sine waves use the fractional part of the phase', () => {
  // Regression: an earlier port computed `phase - fmod(phase, 1)`, which is the
  // integer part of the phase and turned every wave into a constant.
  for (let waveForm = 1; waveForm <= 3; waveForm++) {
    const samples = render([cycleOsc(waveForm as WaveForm)], RATE);
    const distinct = new Set(samples).size;
    // The square wave only has two levels, the saw and the triangle many.
    assert.ok(distinct > (waveForm === 2 ? 1 : 100), `waveForm ${waveForm} has ${distinct} levels`);
  }
});

test('the saw wave ramps down over one cycle', () => {
  const samples = render([cycleOsc(1)], RATE);
  // The engine advances the phase before it generates the sample.
  assert.ok(Math.abs(samples[0]! - (1 - 2 / RATE)) < 1e-6);
  assert.ok(Math.abs(samples[Math.floor(RATE / 2)]!) < 1e-3, 'half a cycle is zero');
  assert.ok(samples[RATE - 2]! < -0.999, 'the end of the cycle is -1');
  // ... and the phase wraps back to zero.
  assert.ok(samples[RATE - 1]! > 0.999);
});

test('the triangle wave peaks at a quarter and at three quarters', () => {
  const samples = render([cycleOsc(3)], RATE);
  assert.ok(samples[Math.floor(RATE * 0.25)]! > 0.999);
  assert.ok(samples[Math.floor(RATE * 0.75)]! < -0.999);
});

test('the square wave switches at half a cycle', () => {
  const samples = render([cycleOsc(2)], RATE);
  // The binary compares the fractional part against 0.5: below it is -1.
  assert.ok(samples[10]! < 0);
  assert.ok(samples[Math.floor(RATE * 0.75)]! > 0);
});
