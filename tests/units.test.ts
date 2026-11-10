import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beatMs,
  formatFrequency,
  formatTime,
  freqToMidi,
  freqToNoteName,
  midiToFreq,
  parseFrequency,
  parseTime,
  snapTime,
  snapToNote,
} from '../src/ui/units.ts';

test('A4 is 440 Hz', () => {
  assert.equal(freqToNoteName(440), 'A4');
  assert.equal(freqToMidi(440), 69);
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
});

test('note names survive the display round trip', () => {
  assert.equal(freqToNoteName(midiToFreq(60)), 'C4');
  assert.equal(freqToNoteName(midiToFreq(61)), 'C#4');
  assert.equal(freqToNoteName(midiToFreq(69)), 'A4');
});

test('a note name parses back to its frequency', () => {
  assert.ok(Math.abs(parseFrequency('A4', 'note') - 440) < 1e-9);
  assert.ok(Math.abs(parseFrequency('C4', 'note') - 261.6255653) < 1e-6);
  assert.equal(parseFrequency('1234.5', 'hz'), 1234.5);
});

test('frequencies are formatted for the display mode', () => {
  assert.equal(formatFrequency(440, 'note'), 'A4');
  assert.equal(formatFrequency(440, 'hz'), '440 Hz');
  assert.equal(formatFrequency(22050, 'hz'), '22.05 kHz');
});

test('times are formatted for the display mode', () => {
  assert.equal(formatTime(500, 'ms', 120), '500.0 ms');
  // Beat numbers are one based: 500 ms at 120 BPM is the start of beat 2.
  assert.equal(formatTime(500, 'beat', 120), '2:0');
  assert.equal(formatTime(0, 'beat', 120), '1:0');
  // At 120 BPM one beat is 500 ms.
  assert.equal(formatTime(250, 'beat', 120), '1:2/4');
});

test('beat:fraction parses back to milliseconds', () => {
  assert.equal(parseTime('1:0', 'beat', 120), 0);
  assert.equal(parseTime('2:0', 'beat', 120), 500);
  assert.equal(parseTime('1:2/4', 'beat', 120), 250);
  assert.equal(parseTime('250', 'ms', 120), 250);
});

test('snapping quantises to the note grid', () => {
  assert.ok(Math.abs(snapToNote(441) - 440) < 1e-9);
  assert.ok(Math.abs(snapToNote(445) - 440) < 1e-9);
  assert.ok(Math.abs(snapToNote(450) - 440) < 1e-9);
  // 452 Hz is still closer to A4 (5.9 % per semitone) than to A#4.
  assert.ok(Math.abs(snapToNote(452) - 440) < 1e-9);
  assert.ok(Math.abs(snapToNote(460) - 466.1637615) < 1e-6);
});

test('snapping quantises to the time grid', () => {
  assert.equal(snapTime(123, 0, 120), 123);
  assert.equal(snapTime(123, 4, 120), 0);
  assert.equal(snapTime(300, 4, 120), 500);
  assert.equal(snapTime(300, 8, 120), 250);
  assert.equal(beatMs(120), 500);
});
