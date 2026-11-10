/**
 * Units and display helpers.
 *
 * The context menu of the original (RT_MENU 152) offered:
 *   Display mode  Hz (0x803B) / Note (0x803C) / Snap to note (0x803D)
 *   Display mode  milliseconds (0x803E) / beat:fraction (0x803F)
 *   Snap to time none (0x8044) / 1-4 (0x8040) / 1-8 (0x8041) / 1-16 (0x8042) / 1-32 (0x8043)
 *
 * The model always stores milliseconds and hertz; the conversions happen for
 * display and for snapping only.
 */

import type { FreqDisplay, SnapTime, TimeDisplay } from '../model/store.ts';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** A4 = 440 Hz, MIDI note 69. */
export const A4_FREQ = 440;
export const A4_MIDI = 69;

export function freqToMidi(freq: number): number {
  if (!(freq > 0)) return A4_MIDI;
  return Math.round(A4_MIDI + 12 * Math.log2(freq / A4_FREQ));
}

export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export function midiToNoteName(midi: number): string {
  const index = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[index]}${octave}`;
}

/** "A4", "C#3", ... */
export function freqToNoteName(freq: number): string {
  return midiToNoteName(freqToMidi(freq));
}

/** Snap a frequency to the nearest equal-tempered semitone. */
export function snapToNote(freq: number): number {
  return midiToFreq(freqToMidi(freq));
}

export function formatFrequency(freq: number, display: FreqDisplay): string {
  if (display === 'note') return freqToNoteName(freq);
  if (Math.abs(freq) >= 1000) return `${(freq / 1000).toFixed(2)} kHz`;
  if (Math.abs(freq) >= 100) return `${freq.toFixed(0)} Hz`;
  return `${freq.toFixed(2)} Hz`;
}

/** Length of one beat in milliseconds. */
export function beatMs(tempo: number): number {
  return 60000 / Math.max(1, tempo);
}

/** Convert milliseconds to a fractional beat position. */
export function msToBeats(ms: number, tempo: number): number {
  return ms / beatMs(tempo);
}

export function beatsToMs(beats: number, tempo: number): number {
  return beats * beatMs(tempo);
}

/** "2:1/4" style beat:fraction rendering. */
export function formatTime(ms: number, display: TimeDisplay, tempo: number): string {
  if (display === 'ms') {
    if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  }
  const beats = msToBeats(ms, tempo);
  const whole = Math.floor(beats);
  const frac = beats - whole;
  const quarters = Math.round(frac * 4);
  if (quarters === 4) return `${whole + 1}:0`;
  if (quarters === 0) return `${whole + 1}:0`;
  return `${whole + 1}:${quarters}/4`;
}

/** Snap a time to the given note subdivision. */
export function snapTime(ms: number, division: SnapTime, tempo: number): number {
  if (!division) return ms;
  const step = (beatMs(tempo) * 4) / division;
  return Math.round(ms / step) * step;
}

/** Round-trip safe number formatting for the parameter fields. */
export function formatNumber(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 100000)) return value.toExponential(3);
  return String(Number(value.toFixed(digits)));
}

export function parseNumber(text: string, fallback = 0): number {
  const v = parseFloat(text);
  return Number.isFinite(v) ? v : fallback;
}

/** Parse a frequency field: either a plain number or a note name such as "A4". */
export function parseFrequency(text: string, display: FreqDisplay): number {
  const trimmed = text.trim();
  if (display === 'note') {
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(trimmed);
    if (m) {
      const base = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const name = m[1]!.toUpperCase() + (m[2] === '#' ? '#' : m[2] === 'b' ? 'b' : '');
      let index = base.indexOf(name);
      if (index < 0 && name.endsWith('b')) index = base.indexOf(name[0] + 'b');
      if (index >= 0) {
        const octave = parseInt(m[3]!, 10);
        return midiToFreq(index + (octave + 1) * 12);
      }
    }
  }
  return parseNumber(trimmed, 0);
}

/** Parse a time field: either milliseconds or a "beat:fraction" pair. */
export function parseTime(text: string, display: TimeDisplay, tempo: number): number {
  const trimmed = text.trim();
  if (display === 'beat') {
    const m = /^(\d+)\s*:\s*(\d+)(?:\/(\d+))?$/.exec(trimmed);
    if (m) {
      const beats = parseInt(m[1]!, 10) - 1;
      const denom = m[3] ? parseInt(m[3]!, 10) : 4;
      const num = parseInt(m[2]!, 10);
      return beatsToMs(beats + (denom ? num / denom : 0), tempo);
    }
  }
  return parseNumber(trimmed, 0);
}
