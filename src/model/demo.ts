/**
 * Built-in songs.
 *
 * FUN_00406110 creates the fallback song used when a file fails to load; the
 * original's demo-song menu entry opened a web page (that page is long gone),
 * so the web port ships a demo that is assembled from the same oscillator
 * model instead.
 */

import { createOsc, createSong, type OscModel, type Song } from './types.ts';

/** Fallback song, used when a file cannot be loaded (FUN_00406110). */
export function createDefaultSong(): Song {
  const osc: OscModel = createOsc({
    startT: 0,
    endT: 1000,
    startF: 440,
    endF: 440,
    startA: 0.6,
    endA: 0.6,
    curveShape1: 1,
  });
  const song = createSong([osc]);
  song.filename = '';
  song.dirty = true;
  return song;
}

/**
 * A short drum-and-bass demo that exercises every feature of the engine:
 * several oscillators, a frequency sweep, an amplitude envelope, a filter and
 * FM/AM modulation.
 */
export function createDemoSong(): Song {
  const beat = 300; // ms at 200 BPM

  const kick = createOsc({
    startT: 0,
    endT: beat * 0.9,
    startF: 150,
    endF: 45,
    startA: 0.5,
    endA: 0,
    curveShape1: 3,
    noiseBW: 0,
    comment: 'kick drum',
  });

  const snare = createOsc({
    startT: beat,
    endT: beat * 1.8,
    startF: 900,
    endF: 220,
    startA: 0.22,
    endA: 0,
    curveShape1: 4,
    waveForm: 1, // saw
    noiseBW: 0.35,
    comment: 'snare',
  });

  const hat = createOsc({
    startT: beat * 0.5,
    endT: beat * 0.72,
    startF: 8000,
    endF: 7000,
    startA: 0.09,
    endA: 0,
    curveShape1: 8,
    waveForm: 2, // square
    noiseBW: 0,
    comment: 'closed hat',
  });

  const bass = createOsc({
    startT: beat * 2,
    endT: beat * 4,
    startF: 110,
    endF: 110,
    startA: 0.28,
    endA: 0.28,
    curveShape1: 1,
    waveForm: 1, // saw
    noiseBW: 0,
    comment: 'saw bass',
  });

  // A second voice an octave up, modulated by the bass through FM and AM.
  const lead = createOsc({
    startT: beat * 2,
    endT: beat * 4,
    startF: 220,
    endF: 330,
    startA: 0.15,
    endA: 0.15,
    curveShape1: 1,
    waveForm: 3, // triangle
    noiseBW: 0,
    fmModBy: 3,
    fmSource: 3,
    fmModFac: 0.6,
    amModBy: 3,
    amModFac: 0.2,
    comment: 'lead, FM and AM modulated by the bass',
  });

  // A filter over the mix, with a slow cutoff sweep.  The amplitude of a
  // filter slot is its resonance: 1.0 is the marginal stability point where
  // the filter rings forever, so the demo stays below it.
  const filter = createOsc({
    role: 1,
    startT: 0,
    endT: beat * 4,
    startF: 400,
    endF: 4000,
    startA: 0.5,
    endA: 0.5,
    curveShape1: 1,
    noiseBW: 0,
    comment: 'sweeping low-pass filter',
  });

  const song = createSong([kick, snare, hat, bass, lead, filter]);
  song.filename = 'Demo (built-in)';
  song.dirty = true;
  return song;
}
