import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atof, atoi, iniFromSong, parseIni, songFromIni } from '../src/model/ini.ts';
import { createOsc, createSong } from '../src/model/types.ts';

test('parseIni keeps the last value of a repeated key, case insensitively', () => {
  const ini = parseIni('[Common]\nSampleFrequency=22050\nsamplefrequency=44100\n');
  assert.equal(ini.get('common')?.get('samplefrequency'), '44100');
});

test('atof / atoi fall back to the caller default', () => {
  assert.equal(atof(undefined, 7), 7);
  assert.equal(atof('abc', 7), 7);
  assert.equal(atof('3.5x', 7), 3.5);
  assert.equal(atoi(undefined, 7), 7);
  assert.equal(atoi('12abc', 7), 12);
  assert.equal(atoi('abc', 7), 7);
});

test('a song survives a .STU round trip', () => {
  const song = createSong([
    createOsc({
      enabled: 2,
      role: 1,
      waveForm: 3,
      startT: 12.5,
      endT: 987.25,
      startF: 123.5,
      endF: 4567.25,
      startA: 0.75,
      endA: 0.125,
      curveShape0: 0.25,
      curveShape1: 2.5,
      curveShape2: 1.5,
      noiseBW: 0.375,
      noiseChangeRate: 3,
      fmModFac: 0.5,
      fmSource: 0,
      amModFac: 0.25,
      amModBy: 0,
      comment: 'a comment',
      wavFile: 'C:\\samples\\kick.wav',
    }),
    createOsc({ startF: 440, endF: 880, startT: 0, endT: 500 }),
  ]);
  song.rate = 44100;

  const text = iniFromSong(song);
  const back = songFromIni(text, 'test.stu');

  assert.equal(back.rate, 44100);
  assert.equal(back.oscillators.length, 2);
  assert.equal(back.filename, 'test.stu');

  const a = back.oscillators[0]!;
  const b = song.oscillators[0]!;
  assert.equal(a.enabled, 2);
  assert.equal(a.role, 1);
  assert.equal(a.waveForm, 3);
  assert.equal(a.startT, b.startT);
  assert.equal(a.endT, b.endT);
  assert.equal(a.startF, b.startF);
  assert.equal(a.endF, b.endF);
  assert.equal(a.startA, b.startA);
  assert.equal(a.endA, b.endA);
  assert.equal(a.curveShape0, b.curveShape0);
  assert.equal(a.curveShape1, b.curveShape1);
  assert.equal(a.curveShape2, b.curveShape2);
  assert.equal(a.noiseBW, b.noiseBW);
  assert.equal(a.noiseChangeRate, b.noiseChangeRate);
  assert.equal(a.comment, b.comment);
  assert.equal(a.wavFile, b.wavFile);
  // FM routing survives the trip through the INI file.
  assert.equal(a.fmSource, 0);
  assert.equal(a.amModBy, 0);
});

test('the loader maps the friendly sample rates onto the real ones', () => {
  assert.equal(songFromIni('[Common]\nSampleFrequency=22000\n').rate, 22050);
  assert.equal(songFromIni('[Common]\nSampleFrequency=44000\n').rate, 44100);
  assert.equal(songFromIni('[Common]\nSampleFrequency=11000\n').rate, 11025);
  assert.equal(songFromIni('[Common]\nSampleFrequency=48000\n').rate, 48000);
});

test('the loader clamps the oscillator count to 64', () => {
  const text = '[Common]\nOscillators=1000\n';
  assert.equal(songFromIni(text).oscillators.length, 64);
});

test('a missing key yields the original default', () => {
  const song = songFromIni('[Common]\nOscillators=0\n[Oscillator 0]\n');
  const osc = song.oscillators[0]!;
  assert.equal(osc.startF, 2000);
  assert.equal(osc.endF, 0);
  assert.equal(osc.startA, 1);
  assert.equal(osc.startT, 0);
  assert.equal(osc.endT, 200);
  assert.equal(osc.curveShape0, 0.1);
  assert.equal(osc.curveShape1, 10);
  assert.equal(osc.curveShape2, 1);
  assert.equal(osc.noiseBW, 0.1);
  assert.equal(osc.noiseChangeRate, 1);
  assert.equal(osc.enabled, 0);
  assert.equal(osc.role, 0);
  assert.equal(osc.waveForm, 0);
  assert.equal(osc.fmSource, -1);
  assert.equal(osc.amModBy, -1);
});
