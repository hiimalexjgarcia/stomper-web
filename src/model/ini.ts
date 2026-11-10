/**
 * `.STU` / `.STP` file codec.
 *
 * The original stores songs as plain Windows INI files written with
 * WritePrivateProfileStringA and read with GetPrivateProfileStringA
 * (FUN_004079A0 / FUN_00407470).  This module reproduces the Win32 profile
 * semantics that matter:
 *
 *   - section headers are `[Name]`
 *   - keys are matched case-insensitively
 *   - a missing key yields the caller's default value
 *   - the original's numeric buffers were 0x3F (63) characters, the path and
 *     comment buffers 0xFA (250) characters
 *   - "SampleFrequency" round values are corrected by the loader:
 *     11000 -> 11025, 22000 -> 22050, 44000 -> 44100
 */

import { createOsc, createSong, MAX_OSC, type OscModel, type Song } from './types.ts';

export type Ini = Map<string, Map<string, string>>;

const SECTION_RE = /^\s*\[([^\]]*)\]\s*$/;

export function parseIni(text: string): Ini {
  const ini: Ini = new Map();
  let section = '';
  ini.set('', new Map());
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const m = SECTION_RE.exec(line);
    if (m) {
      section = m[1].trim().toLowerCase();
      if (!ini.has(section)) ini.set(section, new Map());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    let bag = ini.get(section);
    if (!bag) {
      bag = new Map();
      ini.set(section, bag);
    }
    bag.set(key, value);
  }
  return ini;
}

/** atof() semantics: leading float, 0 when nothing parses. */
export function atof(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const v = parseFloat(value);
  return Number.isNaN(v) ? fallback : v;
}

/** atoi() semantics: leading integer, 0 when nothing parses. */
export function atoi(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const v = parseInt(value, 10);
  return Number.isNaN(v) ? fallback : v;
}

/**
 * Port of FUN_00407470: build a Song from INI text.
 */
export function songFromIni(text: string, filename = ''): Song {
  const ini = parseIni(text);
  const common = ini.get('common') ?? new Map<string, string>();

  let rate = atoi(common.get('samplefrequency'), 22050);
  // The original maps the "friendly" round rates onto the real ones.
  if (rate === 11000) rate = 0x2b11; // 11025
  if (rate === 22000) rate = 0x5622; // 22050
  if (rate === 44000) rate = 0xac44; // 44100

  const count = Math.min(MAX_OSC, atoi(common.get('oscillators'), 0) + 1);
  const oscillators: OscModel[] = [];

  for (let i = 0; i < count; i++) {
    const sec = ini.get(`oscillator ${i}`) ?? new Map<string, string>();
    const num = (k: string, d: number) => atof(sec.get(k), d);
    const int = (k: string, d: number) => atoi(sec.get(k), d);

    const fmModBy = int('fmmodby', -1);
    oscillators.push(
      createOsc({
        enabled: (() => {
          const e = int('enabled', 0);
          if (e === 2) return 2;
          if (e === 0) return 0;
          // Older Stomper files use -1 to mean "On"; the loader takes abs().
          return 1;
        })() as OscModel['enabled'],
        role: Math.min(2, Math.max(0, int('filter', 0))) as OscModel['role'],
        waveForm: Math.min(4, Math.max(0, int('waveform', 0))) as OscModel['waveForm'],
        loopWav: int('loopwav', 0),
        wavFile: (sec.get('wavfile') ?? '').slice(0, 250),
        comment: (sec.get('comment') ?? '').slice(0, 250),
        startF: num('startf', 2000),
        endF: num('endf', 0),
        startA: num('starta', 1),
        endA: num('enda', 0),
        startT: num('startt', 0),
        endT: num('endt', 200),
        curveShape0: num('curveshape0', 0.1),
        curveShape1: num('curveshape1', 10),
        curveShape2: num('curveshape2', 1),
        noiseBW: num('noisebw', 0.1),
        noiseChangeRate: int('noisechangerate', 1),
        amModFac: num('ammodfac', 0),
        amModBy: int('ammodby', -1),
        fmModFac: num('fmmodfac', 0),
        fmModBy,
        // +0x280 is not serialised by the original; derive it from FMModBy so a
        // loaded song keeps its FM routing instead of reading a stale field.
        fmSource: fmModBy,
      }),
    );
  }

  const song = createSong(oscillators);
  song.rate = rate;
  song.filename = filename;
  song.dirty = false;
  song.saved = true;
  return song;
}

/**
 * Port of FUN_004079A0: serialise a Song as INI text.
 */
export function iniFromSong(song: Song): string {
  const out: string[] = [];
  out.push('[Common]');
  out.push(`SampleFrequency=${song.rate}`);
  out.push(`Oscillators=${Math.max(0, song.oscillators.length - 1)}`);
  out.push('');

  song.oscillators.forEach((o, i) => {
    out.push(`[Oscillator ${i}]`);
    out.push(`Enabled=${o.enabled}`);
    out.push(`Filter=${o.role}`);
    out.push(`WaveForm=${o.waveForm}`);
    out.push(`WavFile=${o.wavFile}`);
    out.push(`Comment=${o.comment}`);
    out.push(`LoopWav=${o.loopWav}`);
    out.push(`StartF=${o.startF}`);
    out.push(`EndF=${o.endF}`);
    out.push(`StartA=${o.startA}`);
    out.push(`EndA=${o.endA}`);
    out.push(`StartT=${o.startT}`);
    out.push(`EndT=${o.endT}`);
    out.push(`CurveShape0=${o.curveShape0}`);
    out.push(`CurveShape1=${o.curveShape1}`);
    out.push(`CurveShape2=${o.curveShape2}`);
    out.push(`NoiseBW=${o.noiseBW}`);
    out.push(`NoiseChangeRate=${o.noiseChangeRate}`);
    out.push(`AMModFac=${o.amModFac}`);
    out.push(`AMModBy=${o.amModBy}`);
    out.push(`FMModFac=${o.fmModFac}`);
    out.push(`FMModBy=${o.fmSource >= 0 ? o.fmSource : o.fmModBy}`);
    out.push('');
  });

  return out.join('\r\n');
}
