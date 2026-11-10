import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderSongSync } from '../src/audio/renderSync.ts';
import { prepareEngine } from '../src/dsp/engine.ts';
import { mixSample } from '../src/dsp/mixer.ts';
import { songFromIni } from '../src/model/ini.ts';
import { createDemoSong } from '../src/model/demo.ts';
import { createOsc } from '../src/model/types.ts';

const RATE = 22050;

test('the main-thread renderer matches the engine loop sample by sample', () => {
  const model = [
    createOsc({ waveForm: 0, startF: 440, endF: 220, startA: 0.5, endA: 0.2, curveShape1: 2, startT: 0, endT: 200 }),
    createOsc({ waveForm: 1, startF: 110, endF: 110, startA: 0.4, endA: 0.4, curveShape1: 1, startT: 0, endT: 200 }),
  ];
  const result = renderSongSync(model, RATE, [null, null]);

  const ctx = prepareEngine(model, RATE, [null, null]);
  assert.equal(result.frames, ctx.maxLen);
  assert.equal(result.rate, RATE);
  for (let i = 0; i < result.frames; i++) {
    // The buffer is 32 bit, the mixer works in doubles.
    assert.equal(result.samples[i], Math.fround(mixSample(ctx, i)), `sample ${i} differs`);
  }
  let peak = 0;
  for (const s of result.samples) peak = Math.max(peak, Math.abs(s));
  assert.equal(result.peak, peak);
});

test('the built-in demo renders inside [-1, 1]', () => {
  const song = createDemoSong();
  const result = renderSongSync(song.oscillators, RATE, song.oscillators.map(() => null));
  assert.ok(result.peak <= 1.0001, `peak was ${result.peak}`);
  assert.ok(result.peak > 0.4, `peak was ${result.peak}`);
  for (const s of result.samples) assert.ok(Number.isFinite(s), `not finite: ${s}`);
});

test('the noise-free reference examples match their WAV renders', () => {
  // These ship with the repository and were rendered by the original binary.
  // They are noise-free, so a fresh (seed 1) render can reproduce the file
  // exactly, up to the original's x87-vs-JS rounding in the last LSB.
  for (const name of ['Example1.stu', 'Example2.stu', 'Example3.stu', 'Example4.stu', 'Example5.stu']) {
    const source = readFileSync(new URL(`./examples/${name}`, import.meta.url), 'utf8');
    const song = songFromIni(source, name);
    const raw = readFileSync(new URL(`./examples/${name}.wav`, import.meta.url));
    const reference = new Int16Array(raw.buffer, raw.byteOffset + 44, (raw.length - 44) / 2);
    const result = renderSongSync(song.oscillators, song.rate, song.oscillators.map(() => null));

    assert.equal(result.frames, reference.length, `${name}: frame count`);
    let maxDiff = 0;
    for (let i = 0; i < reference.length; i++) {
      const q = Math.trunc(Math.max(-1, Math.min(1, result.samples[i]!)) * 32760);
      maxDiff = Math.max(maxDiff, Math.abs(q - reference[i]!));
    }
    assert.ok(maxDiff <= 1, `${name}: max sample difference ${maxDiff}`);
  }
});
