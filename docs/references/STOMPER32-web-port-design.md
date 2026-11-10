# Stomper Hyperion — Web Application Port Design

Derived from the static REA/Ghidra analysis of `STOMPER32.EXE` (see `STOMPER32-analysis.md`).
Every design decision below is traced back to a recovered function, so the port is a
*transcription* of the binary's behaviour, not a re-imagining of it.

---

## 0. Executive summary

| Original concern | Web equivalent |
|---|---|
| Per-sample DSP loop `FUN_004083B0` (linear, order-dependent mix) | **`AudioWorkletProcessor`** — the only way to reproduce a sequential, order-dependent accumulator |
| Model loader/writer `FUN_00407470` / `FUN_004079A0` (Win32 INI) | Pure-TS INI reader/writer with Win32 profile semantics + **File System Access API** |
| `PlaySoundA(temp.wav, NULL, SND_ASYNC)` `FUN_004043B0` | Live `AudioWorkletNode` (instant) **and** `OfflineAudioContext` render → WAV blob (bit-faithful export) |
| Engine init `FUN_004081F0` (derived state per edit) | `prepareEngine()` → flat `Float64Array` → `port.postMessage` to the worklet |
| Snapshot undo `FUN_004059E0` / restore `FUN_00405870` | Immutable model snapshots in an undo stack (same payload, multi-level) |
| Custom-drawn grid controls (`0x401E30`, `0x402970`, …) | **Canvas 2D** + Pointer Events for drag editing, snapping and display modes |
| `CTabCtrl` oscillator tabs `FUN_00404A40` | React tab strip; the "New" tab becomes an inline "+" affordance |
| List control + context menu 152 | `<ul>` + custom context menu, `role="menu"` semantics |
| Win32 accelerators (Ctrl+N/O/S/Z/X/C/V/M/B) | `keydown` handler with a command table mirroring the msg map |
| TUAREG plugin registration `FUN_00406580` | **Dead end** — replaced by "Export WAV / .STU for DAW use" |
| ZapNews `news.swf` (Flash) `FUN_00407290` | **Dead end** — replaced by a JSON feed panel or dropped |
| Trial check via `GetProfileIntA` (registry) `FUN_004071D0` | Optional signed licence file + `localStorage` |
| DDE `GetMusic` / `CloseWindow` `FUN_00403090` | `BroadcastChannel` (same-origin tabs) or a local WebSocket relay |

**Non-negotiable architectural fact:** the original synth is *not* a node graph. Its mixer
(`FUN_004083B0`) walks the oscillator list in order and every slot mutates **one shared
running accumulator**; filters read and write that accumulator, so slot *i* filters what
slots *0..i-1* produced, and an oscillator's contribution is summed in slot order. A
native WebAudio node graph sums in parallel and cannot express that. The port must be a
single `AudioWorkletProcessor` with the slot loop inside `process()`.

---

## 1. Runtime architecture

```
┌──────────────── main thread ─────────────────┐        ┌──── audio thread ────┐
│  React UI                                    │        │                      │
│   TabStrip (FUN_00404A40)                    │        │  StomperProcessor    │
│   OscEditor  (FUN_00404800)                  │        │   ├ mixSample()      │
│   Grid canvases (0x401E30 family)            │        │   │  └ waveform()      │
│   ContextMenu (menu 152)                     │        │   └ prepareEngine()  │
│        ▲                                     │        │        ▲             │
│        │ model (immutable)                   │ postMessage │        │      │
│  Store + undo snapshots (FUN_004059E0)  ─────┼────────────┘        │      │
│                                                │  derived state   │      │
│  INI codec (FUN_00407470 / 0x4079A0)          │                  │      │
│  File System Access API  ⇄  .STU/.STP          │                  │      │
│  OfflineAudioContext → WAV encoder (FUN_004087F0 / 0x408990)       │      │
└────────────────────────────────────────────────┘        └──────────────────────┘
```

* **One worklet, many oscillators.** A single `AudioWorkletNode` renders the whole song.
  64 slots × 128 frames = 8 192 mix iterations per render quantum — trivial for any CPU.
* **Two audio paths.**
  * *Live preview* → `AudioContext` + worklet → speakers. Zero render latency.
  * *Export / Normalize* → `OfflineAudioContext({ sampleRate: model.rate })` →
    `AudioBuffer` → 44-byte WAV encoder → `Blob` download. This is the bit-faithful
    equivalent of `FUN_004087F0` writing a WAV to a temp file.
* **Model lives on the main thread; derived state lives in the worklet.** Exactly the split
  the binary uses: the persistent model occupies slot bytes `+0x000..+0x284`, the derived
  engine state `+0x288..+0x2CC` is recomputed by `FUN_004081F0` whenever the model changes.

---

## 2. Data model

The 0x308-byte slot splits cleanly into a *persistent* part (INI-serialisable) and a
*derived* part (recomputed at "engine init"). Mirroring that split in TypeScript keeps the
port honest and makes undo snapshots trivially small.

```ts
// src/model/oscillator.ts
export const MAX_OSC = 0x40;          // FUN_00407470 clamps the count to 64
export const SLOT_BYTES = 0x308;      // stride used by FUN_004081F0 / FUN_004083B0

export type Enabled = 0 | 1 | 2;      // +0x25C  0=Off 1=On 2=Inaudible (modulator only)
export type Role    = 0 | 1 | 2;      // +0x264  0=oscillator 1/2=filter
export type Wave    = 0 | 1 | 2 | 3 | 4; // +0x268 sine tri sq/saw saw wav

/** Persistent model — slot bytes +0x000..+0x284. */
export interface OscModel {
  wavFile: string;          // +0x000  char[250]
  comment: string;          // +0x100  char[250]
  startT: number;           // +0x208  ms (canonical unit; see §6)
  endT: number;             // +0x210
  startF: number;           // +0x218  Hz
  endF: number;             // +0x220  Hz
  startA: number;           // +0x228
  endA: number;             // +0x230
  noiseBW: number;          // +0x238
  curveShape0: number;      // +0x240  timing-curve exponent   pow(t, cs0)
  curveShape1: number;      // +0x248  amplitude-curve exponent pow(t, cs1)
  curveShape2: number;      // +0x250  waveform-curve exponent  sign(v)*|v|^cs2
  noiseChangeRate: number;  // +0x258
  enabled: Enabled;         // +0x25C
  role: Role;               // +0x264
  waveForm: Wave;           // +0x268
  loopWav: number;          // +0x26C
  fmModFac: number;         // +0x270
  amModFac: number;         // +0x278
  fmModBy: number;          // +0x27C  source index (-1 = none)
  fmSource: number;         // +0x280  source index (-1 = none)
  amModBy: number;          // +0x284  source index (-1 = none)
}

/** Derived engine state — slot bytes +0x288..+0x2CC, produced by FUN_004081F0. */
export interface OscState {
  envStart: number;         // +0x288  samples
  envEnd: number;           // +0x28C  samples
  envLen: number;           // +0x290  samples
  phaseInc: number;         // +0x298  rad/sample (sine) or cycles/sample
  phaseIncDelta: number;    // +0x2A0  glide delta
  ampDelta: number;         // +0x2A8  EndA - StartA
  phaseAcc: number;         // +0x2B0  phase accumulator (osc)
  filterState: number;      // +0x2B0  one-pole state (filter)
  noiseOffset: number;      // +0x2B8
  lastOut: number;          // +0x2C0  also the FM/AM source value
  noiseCounter: number;     // +0x2C8
  chained: boolean;         // +0x2CC  "inherit phase/output from previous slot"
}

export interface Song {
  rate: number;             // dialog +0x9FC  22050 | 44100 | 48000
  oscillators: OscModel[];  // dialog +0xA00, count at +0x31200
  filename: string;         // dialog +0x78
  dirty: boolean;           // dialog +0x84
  saved: boolean;           // dialog +0x85
}
```

> The original keeps the model and the derived state **inside one struct**, and the undo
> snapshot (`this+0x18E00`, 0x18400 bytes = 64 × 0x308) copies *both*. In the port the
> snapshot only needs the persistent part (a few kB), which is one of the few places where
> the web version is strictly better than the original.

---

## 3. DSP port

### 3.1 Engine initialisation — port of `FUN_004081F0`

```ts
// src/dsp/engine.ts
// The binary's own truncated 2π constant (0x00437788 = 6.2831852).
// Using the correctly rounded Math.PI * 2 drifts visibly over long renders.
const TWO_PI = 6.2831852;

export interface DspCtx {
  model: OscModel[];
  state: OscState[];
  count: number;
  rate: number;          // effective render rate (see §5)
  maxLen: number;        // samples
  wavSamples: Float32Array[];   // decoded mono PCM for waveForm === 4
}

/** Port of FUN_004081F0(slots, rate, count, &maxLen, k1, k2). */
export function prepareEngine(model: OscModel[], rate: number, k1 = 1, k2 = 1): DspCtx {
  const state: OscState[] = [];
  let maxLen = 0;

  for (let i = 0; i < model.length; i++) {
    const S = model[i];
    const st: OscState = {
      envStart: Math.trunc(S.startT * rate * 0.001),
      envEnd:   Math.trunc(S.endT   * rate * 0.001),
      envLen: 0, phaseInc: 0, phaseIncDelta: 0, ampDelta: 0,
      phaseAcc: 0, filterState: 0, noiseOffset: 0, lastOut: 0,
      noiseCounter: 0, chained: false,
    };
    st.envLen = st.envEnd - st.envStart;
    st.ampDelta = S.endA - S.startA;

    if (S.role === 0) {
      // oscillator: phase increment = f / rate  (sine is scaled to radians)
      const inc  = (k1 * S.startF) / rate;
      const inc2 = (k1 * S.endF)   / rate;
      st.phaseInc       = S.waveForm === 0 ? inc  * TWO_PI : inc;
      st.phaseIncDelta  = S.waveForm === 0 ? inc2 * TWO_PI : inc2;
      st.phaseIncDelta -= st.phaseInc;
    } else {
      // filter: one-pole coefficient with the original's odd normalisation
      // (integer division before the multiply, as in the binary)
      const norm = Math.trunc(rate / 10000) * rate;
      const inc  = (k2 * S.startF * 2) / norm;
      const inc2 = (k2 * S.endF   * 2) / norm;
      st.phaseInc       = inc;
      st.phaseIncDelta  = inc2 - inc;
    }

    // unison / "chained to previous": the previous envelope must end exactly
    // where this one starts, and both slots must have the same role
    if (i > 0) {
      const p = state[i - 1];
      if (p.envEnd === st.envStart && model[i - 1].role === S.role) st.chained = true;
    }
    if (st.envEnd > maxLen && S.enabled !== 0) maxLen = st.envEnd;

    state.push(st);
  }
  return { model, state, count: model.length, rate, maxLen, wavSamples: [] };
}
```

Note the duplicate/unison rule from the binary: *"prev slot's `envEnd` == this `envStart`
**and** prev role == this role"* → the new slot inherits the previous slot's phase (or filter
memory) and last output the first time it is rendered.

### 3.2 Mixer — port of `FUN_004083B0`

```ts
// src/dsp/mixer.ts
/** One output sample. Order matters: the original mutates a single accumulator. */
export function mixSample(ctx: DspCtx, idx: number): number {
  let mix = 0;

  for (let i = 0; i < ctx.count; i++) {
    const S = ctx.model[i];
    const st = ctx.state[i];

    if (S.enabled === 0) continue;                       // Off
    if (idx < st.envStart || idx >= st.envEnd) continue; // outside the envelope

    if (st.chained) {                                    // inherit from the previous slot
      st.chained = false;
      if (S.role === 0) st.phaseAcc = ctx.state[i - 1].phaseAcc;
      else              st.filterState = ctx.state[i - 1].filterState;
      st.lastOut  = ctx.state[i - 1].lastOut;
    }

    const t  = (idx - st.envStart) / (st.envLen || 1);
    const tf = Math.pow(t, S.curveShape0);   // timing curve
    const ta = Math.pow(t, S.curveShape1);   // amplitude curve

    let amp = S.startA + ta * st.ampDelta;
    let ph  = st.phaseInc + tf * st.phaseIncDelta + st.noiseOffset;

    // ---- FM: the factor scales the whole phase term (multiplicative) ----
    if (S.fmSource >= 0 && S.fmModFac !== 0) {
      const src = ctx.state[S.fmSource].lastOut;
      ph = S.fmModFac >= 0 ? ph * src * S.fmModFac + ph : -(ph * src * S.fmModFac);
    }
    // ---- AM: the envelope is scaled the same way ----
    if (S.amModBy >= 0 && S.amModFac !== 0) {
      const src = ctx.state[S.amModBy].lastOut;
      amp = S.amModFac >= 0 ? amp * src * S.amModFac + amp : -(amp * src * S.amModFac);
    }

    if (S.role === 0) {
      // ============ OSCILLATOR ============
      st.phaseAcc += ph;
      const s = waveform(ctx, i, st.phaseAcc) * amp;
      if (S.enabled === 1) mix += s;     // Inaudible (2) modulates but is not audible
      if (S.noiseBW > 0) {
        // The RNG is advanced only when a re-roll condition fires.
        if (S.noiseChangeRate === 0) {
          if (s * st.lastOut < 0) st.noiseOffset = noise() * S.noiseBW * ph;
        } else {
          st.noiseCounter += 1;
          if (S.noiseChangeRate < st.noiseCounter) {
            st.noiseOffset = noise() * S.noiseBW * ph;
            st.noiseCounter = 0;
          }
        }
      }
      st.lastOut = s;
    } else {
      // ============ FILTER (one-pole over the running mix) ============
      const next = amp * st.filterState + (mix - st.lastOut) * ph;
      st.filterState = next;
      st.lastOut = next + st.lastOut;
      if (S.enabled === 1) mix = st.lastOut;   // Enabled 2 only updates the state
    }
  }
  return mix;
}
```

### 3.3 Waveform generator — port of `FUN_00407DB0`

```ts
// src/dsp/waveform.ts
export function waveform(ctx: DspCtx, i: number, phase: number): number {
  const S = ctx.model[i];
  let v: number;

  switch (S.waveForm) {
    case 0:                                   // sine (phase already in radians)
      v = Math.sin(phase);
      break;
    case 1:                                   // falling ramp (the "saw" wave)
      v = 1 - 2 * fmod(phase, 1);
      break;
    case 2:                                   // duty-cycle square (threshold from cs2)
      v = Math.pow(fmod(phase, 1), S.curveShape2) > 0.5 ? 1 : -1;
      break;
    case 3: {                                 // triangle, breakpoints 0.25 / 0.75
      const x = fmod(phase, 1);
      v = x < 0.25 ? x * 4
        : x <= 0.75 ? 1 - (x - 0.25) * 4
        : (x - 0.75) * 4 - 1;
      break;
    }
    case 4: {                                 // decoded WAV frame (no interpolation)
      const pcm = ctx.wavSamples[i];
      const n = pcm.length;
      const idx = S.loopWav === 0
        ? Math.min(Math.trunc(phase), n - 1)   // clamp
        : ((Math.trunc(phase) % n) + n) % n;   // wrap
      v = pcm[idx];
      break;
    }
    default:
      v = phase;
  }

  // CurveShape2: sign(v) * |v|^cs2  (the binary's two fchs cancel out)
  return v > 0 ? Math.pow(v, S.curveShape2) : -Math.pow(-v, S.curveShape2);
}

/** fmod semantics: the result keeps the sign of the dividend (JS % does the same). */
const fmod = (a: number, b: number) => a % b;

/** Port of the original's noise generator FUN_00407FD0 (double in [-1,1]). */
export function noise(): number {
  // MSVC _rand() LCG, seeded 1, exactly like the original (see noise.ts).
  return nextRandom() * 2 - 1;
}
```

### 3.4 The worklet

```ts
// src/dsp/stomper-processor.ts  (loaded via new URL('./stomper-processor.ts', import.meta.url))
class StomperProcessor extends AudioWorkletProcessor {
  private ctx: DspCtx;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.ctx = options.processorOptions.ctx;
    this.port.onmessage = (e) => { this.ctx = e.data.ctx; };   // model / derived-state update
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    for (let n = 0; n < out.length; n++) {
      out[n] = mixSample(this.ctx, this.sampleIndex++);
    }
    return true;                       // keep alive
  }
}
registerProcessor('stomper-processor', StomperProcessor);
```

`prepareEngine()` runs on the main thread whenever the model changes (the port of
`FUN_004081F0`) and the resulting flat state is `postMessage`d to the worklet, which swaps it
in on a block boundary — mirroring the binary, where `FUN_004081F0` re-runs before each render.

---

## 4. WAV input/output

| Original | Port |
|---|---|
| `FUN_00407FF0` — opens the file, reads the 44-byte header, rejects non-PCM with *"Sorry, compressed wav, i dont grok that yet!"* | `ctx.decodeAudioData(arrayBuffer)`; if the decoder reports a compressed format, show the same message. The original's PCM-only restriction becomes "anything the browser can decode" (a superset) — or keep a strict PCM check to stay faithful |
| `+0x300 frameSize`, `+0x304 frameCount` | `buffer.length` per channel; downmix to mono `Float32Array` and transfer it to the worklet |
| `FUN_004087F0` + `FUN_00408990` — writes the header, streams 16-bit samples, returns the peak | `OfflineAudioContext` → `AudioBuffer` → `encodeWav()` below → `Blob` |

```ts
// src/audio/wav.ts — mirrors FUN_00408990 (44-byte canonical header, 16-bit PCM)
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const bytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);            // PCM
  v.setUint16(22, 1, true);            // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);     // byte rate
  v.setUint16(32, 2, true);            // block align
  v.setUint16(34, 16, true);           // bits
  str(36, 'data'); v.setUint32(40, bytes, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // The original multiplies by 32760.0 (0x00437790), not 32767/32768, and
    // __ftol truncates toward zero.
    v.setInt16(44 + i * 2, Math.trunc(s * 32760), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
```

---

## 5. The sample-rate problem (the one real port hazard)

In the binary, `rate` is simultaneously:

* the **output device rate** (the file rate of the rendered WAV), and
* the **model rate** used by the DSP: `envStart = StartT * rate * 0.001` and
  `phaseInc = f / rate`.

A browser `AudioContext` has a fixed rate (commonly 44.1 kHz or 48 kHz) that the page cannot
choose. Two coherent strategies:

1. **Live preview at the device rate** — substitute `ctx.sampleRate` for `rate` in *both*
   formulas. Pitch and timing stay correct (the envelope is measured in ms, the phase in
   cycles/sample), but the rendered sample count differs from the original by the rate ratio.
   This is what a user expects from a live instrument.
2. **Export at the selected rate** — use `new OfflineAudioContext(1, len, model.rate)`.
   The result is numerically identical to the original's WAV (same `envStart`, same
   `phaseInc`), i.e. true 22050 / 44100 / 48000 Hz output.

Use **both**: `rate` in the model selects the export rate (and the Special ▸ Sample Frequency
radio group), while live playback always uses the device rate. Document it in the UI, because
the original's 22050 preview genuinely sounded duller than a 48 kHz render.

`maxLen` (the number of samples to render) comes from the same `FUN_004081F0` loop:
`max over enabled slots of envEnd` — which in the original is what
`FUN_004080E0` also computes for the on-screen grid.

---

## 6. Persistence — the `.STU` / `.STP` INI format

The original's file format is plain Windows INI written with
`GetPrivateProfileStringA` / `WritePrivateProfileStringA`. Keeping it means 20-year-old
songs still load, and the web app can be a drop-in replacement for the desktop app.

```ts
// src/model/ini.ts — Win32 profile semantics
//  * section = [Common] | [Oscillator N]
//  * key lookup is case-insensitive (GetPrivateProfileString)
//  * a missing key yields the caller's default string
//  * the original's buffers were 0x3F (63) chars for numbers and 0xFA (250) for paths
export type Ini = Map<string, Map<string, string>>;

export function parseIni(text: string): Ini { /* ... */ }
export function writeIni(ini: Ini): string { /* ... */ }
export function loadSong(text: string): Song {
  const ini = parseIni(text);
  const common = ini.get('common')!;

  let rate = parseInt(common.get('samplefrequency') ?? '22050', 10) || 0;
  // the original maps the "nice" round rates onto the real ones
  if (rate === 11000) rate = 0x2B11;   // 11025
  if (rate === 22000) rate = 0x5622;   // 22050
  if (rate === 44000) rate = 0xAC44;   // 44100

  const count = Math.min(MAX_OSC, (parseInt(common.get('oscillators') ?? '0', 10) || 0) + 1);
  const oscillators: OscModel[] = [];
  for (let i = 0; i < count; i++) {
    const sec = ini.get(`oscillator ${i}`)!;
    const num = (k: string, d: number) => { const v = parseFloat(sec.get(k) ?? ''); return Number.isNaN(v) ? d : v; };
    const int = (k: string, d: number) => { const v = parseInt(sec.get(k) ?? '', 10); return Number.isNaN(v) ? d : v; };
    oscillators.push({
      wavFile: sec.get('wavfile') ?? '',
      comment: sec.get('comment') ?? '',
      enabled: Math.abs(int('enabled', 0)) as Enabled,   // -1 in old files means On
      role:    int('filter', 0) as Role,
      waveForm:int('waveform', 0) as Wave,
      loopWav: int('loopwav', 0),
      startF:  num('startf', 2000),
      endF:    num('endf', 0),
      startA:  num('starta', 1),
      endA:    num('enda', 0),
      startT:  num('startt', 0),
      endT:    num('endt', 200),
      curveShape0: num('curveshape0', 0.1),
      curveShape1: num('curveshape1', 10),
      curveShape2: num('curveshape2', 1),
      noiseBW:     num('noisebw', 0.1),
      noiseChangeRate: int('noisechangerate', 1),
      amModFac: num('ammodfac', 0),
      amModBy:  int('ammodby', -1),    // +0x284
      fmModFac: num('fmmodfac', 0),
      fmModBy:  int('fmmodby', -1),    // +0x27C
      fmSource: -1,                   // +0x280 — not INI-serialised (see §11.9)
    });
  }
  return { rate, oscillators, filename: '', dirty: true, saved: false };
}
```

**File System Access API** replaces `CFileDialog`:

```ts
// Open…  (menu id 0xE101 → FUN_00404490)
const [handle] = await window.showOpenFilePicker({
  types: [{ description: 'Stomper files', accept: { 'audio/x-stomper': ['.STU', '.STP'] } }],
});
const song = loadSong(await (await handle.getFile()).text());

// Save as…  (0x8011 → FUN_00404630) — falls back to a download when the API is unavailable
const handle = await window.showSaveFilePicker({ suggestedName: 'song.stu' });
const w = await handle.createWritable(); await w.write(writeIni(toIni(song))); await w.close();
```

`File System Access` is Chromium-only; keep an `<input type="file">` + `download` fallback so
the app still works in Firefox/Safari.

---

## 7. State, undo and the "dirty" flag

The binary's undo is snapshot-based and, notably, *single-level* in practice:
`FUN_004059E0` (called before every destructive edit — normalize, insert, delete, preview)
frees the record chain at `this+0x98` and copies the entire model into the single snapshot
buffer at `this+0x18E00`; `FUN_00405870` restores it, rebuilds the tab list
(`FUN_00404A40`), re-selects the tab (`TCM_SETCURSEL`) and repaints (`FUN_00404800`).

The web port keeps the same *snapshot* idea but makes it a proper stack:

```ts
// src/model/store.ts
interface History { past: Snapshot[]; future: Snapshot[]; }
interface Snapshot { oscillators: OscModel[]; count: number; tab: number; subTab: number; }

const push = (label: string) => {
  past.push({ oscillators: structuredClone(song.oscillators), count: song.oscillators.length,
               tab: ui.tab, subTab: ui.subTab });
  future.length = 0;
};
const undo = () => {
  const s = past.pop(); if (!s) return;
  future.push(current());
  apply(s);              // → rebuild tabs (FUN_00404A40) + repaint (FUN_00404800)
};
```

`dirty` (`+0x84`) / `saved` (`+0x85`) map 1:1 to the store's flags and drive the title-bar
asterisk produced by `FUN_004061C0` (`"untitled"` when there is no filename, `*` when the
document has unsaved changes).

---

## 8. UI reconstruction

The original is a custom-drawn MFC app: a `CTabCtrl` of oscillators, a sub-tab strip
(Frequency / Amplitude / Waveshape | Cutoff F / Resonance), a list control with a rich
context menu, and several bespoke "grid" widgets (`0x401E30`, `0x402970`, `0x401540`,
`0x401640`, `0x401750`, `0x401980`, `0x401A60`) that draw the envelope shapes.

| Original widget | Web component |
|---|---|
| Oscillator tab strip (`FUN_00404A40`, `CTabCtrl` @ `+0x313A0`) | `<div role="tablist">` — one tab per oscillator (caption = index, plus the filter name when `role != 0`) with a status dot/icon for Off / On / Inaudible, plus the trailing **"New"** tab |
| Oscillator list control (@ `+0x31380`) | `<ul role="listbox">` with the same ordering, selection model and the 152 context menu |
| Grid / envelope editors (Frequency rect `+0x31228`, Amplitude rect `+0x31230`, Cutoff page `FUN_00409A10`) | `<canvas>` per page, drawn with 2D context; pointer events implement drag-to-edit |
| Sub-tab strip (@ `+0x313F8`) | `role="tablist"` with three tabs |
| Radio groups On/Off/Inaudible (`0x40C/0x40D/0x40E`), Osc/Filter (`0x410/0x411`) | `<input type="radio">` groups, driven by `slot.enabled` / `slot.role` |
| Title bar (`FUN_004061C0`) | `document.title` + an in-app header |
| Accelerators from menu 131 | `keydown` handler: Ctrl+N/O/S, Ctrl+Z/X/C/V, Ctrl+M, Ctrl+B |

### 8.1 Canvas envelope editor

The original draws the frequency envelope as a curve from `startF` to `endF` over the
oscillator's time span, with a draggable start/end handle. A faithful canvas version:

```ts
// src/ui/Grid.tsx
function drawGrid(ctx: CanvasRenderingContext2D, slot: OscModel, st: OscState, rate: number) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  // time axis: 0 .. max(EndT)  (the original's grid metric, FUN_004080E0)
  // freq axis: min(startF,endF) .. max(startF,endF), or note numbers in "Note" mode
  // curve: pow(t, curveShape0) applied to the frequency sweep  (matches the engine)
  for (let i = 0; i <= 256; i++) {
    const t = i / 256;
    const f = slot.startF + (slot.endF - slot.startF) * Math.pow(t, slot.curveShape0);
    const x = (slot.startT + t * (slot.endT - slot.startT)) / maxEndT * w;
    const y = h - (f - fMin) / (fMax - fMin) * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}
```

The exponent `curveShape0`/`curveShape1` must be applied with the **same** `pow` the engine
uses, otherwise the drawn envelope and the audible envelope diverge.

### 8.2 Display modes and snapping (menu 152)

* **Hz ↔ Note**: 12-TET conversion, A4 = 440 Hz. The exact table used by the original is a
  display-only detail that the decompilation did not pin down; calibrate it against the
  desktop app and keep it in one module (`src/ui/notes.ts`).
* **ms ↔ beat:fraction**: the app keeps a tempo (status field at `+0x312B0`). Store `startT`
  / `endT` canonically in **milliseconds** (that is what the INI holds and what the engine
  consumes) and convert for display and for snapping:
  `beats = ms / (60000 / tempo)`, `fraction = beats - floor(beats)`.
* **Snap to note / 1-4 … 1-32**: quantise the dragged value to the nearest grid before
  committing it to the model.

---

## 9. Feature-parity matrix

| Original command | Handler | Web implementation |
|---|---|---|
| File ▸ New `0xE100` | `0x4061A0` | reset the store to an empty song (`FUN_00406110` default), rebuild tabs, mark dirty |
| File ▸ Open… `0xE101` | `0x404490` | `showOpenFilePicker` → `loadSong()` |
| File ▸ Save `0xE103` | `0x4060D0` | `writeIni()` → file handle (or download) |
| File ▸ Save as… `0x8011` | `0x404630` | `showSaveFilePicker` → `writeIni()` |
| File ▸ Exit `0x8005` | `0x405D10` | "save changes?" prompt (`FUN_00406350`) then `close()` / `beforeunload` |
| Edit ▸ Undo `0xE12B` | `0x405AA0` | `undo()` → restore snapshot, rebuild tabs, repaint |
| Edit ▸ Cut/Copy/Paste `0xE123/0xE122/0xE125` | `0x405AF0/0x405B80/0x405C00` | the original forwards `WM_CUT 0x300` / `WM_COPY 0x301` to the list control; the web version copies the selected oscillator(s) as JSON to the clipboard and pastes them (the binary's own clipboard format is not documented) |
| Edit ▸ Insert/Delete oscillator `0x8007/0x8008` | `0x405D00/0x405CF0` | splice the oscillator array, renumber tabs |
| Special ▸ Sample Frequency `0x8029-0x802B` | `0x406B80/0x406BA0/0x406BC0` | set `song.rate` (export rate) and update the radio group (`FUN_00406E80`) |
| Special ▸ Normalize `0x8027` | `0x406A70` | offline render → find the peak → divide `startA`/`endA` of every `enabled===1 && role===0` slot → re-render |
| Special ▸ Little Drummer Boy `0x8028` | `0x406A50` | `window.open('http://www.Master-Zap.com/ldb')` — same link, dead upstream |
| Special ▸ TUAREG plugin `0x8026` | `0x4067C0` | **drop**; replace with "Export WAV for your DAW" |
| Web ▸ links `0x802F-0x8045` | `0x406BE0…` | `window.open(url)` for the same URLs |
| Help ▸ Heeeellp `0x803A` | `0x4071B0` | link to the (archived) documentation |
| Help ▸ About `0x0010` | `0x406950` | an about modal with the version string `5.01` / build `54` |
| Preview button `0x03F1` | `0x4043B0` | start/stop the worklet (re-render only when `dirty`) |
| List context menu 152 | — | custom context menu wired to the same command ids |
| Timer `0x113` | `0x405D30` | the periodic preview playback / status refresh → `setInterval` or, better, `requestAnimationFrame` for the grid redraw |

### 9.1 Normalize — faithful port

```ts
// Port of FUN_00406A70
async function normalize(song: Song): Promise<OscModel[]> {
  const buf = await renderOffline(song);              // FUN_004087F0
  let peak = 0;
  for (const s of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) {
    song.oscillators.forEach((o) => {
      if (o.enabled === 1 && o.role === 0) { o.startA /= peak; o.endA /= peak; }
    });
  }
  return song.oscillators;
}
```

Note the original only scales **audible oscillators** (`enabled == 1`) that are **not
filters** (`role == 0`) — exactly the condition above.

---

## 10. Legacy features that cannot survive in a browser

| Feature | Why it dies | Replacement |
|---|---|---|
| TUAREG VST-host plugin registration (`FUN_00406580`) | TUAREG (1999) no longer exists; plugin hosting moved to VST3/AU/CLAP | export `.STU` + `.wav`; optionally ship the worklet as a public `AudioWorklet` module so other pages can load Stomper voices |
| ZapNews Flash player (`news.swf` in `STOMPER32.HLP`) | Flash is dead | a small JSON feed panel, or drop |
| Trial-day check via `GetProfileIntA` (registry) | browsers have no registry | a signed licence blob (WebCrypto `verify`) stored in `localStorage`/`IndexedDB`, or nothing |
| DDE service `GetMusic` / `CloseWindow` | no DDE in browsers | `BroadcastChannel('stomper')` for same-origin tabs, or a WebSocket to a local helper |
| `PlaySoundA` of a temporary `.wav` | unnecessary in a browser | live worklet node; keep "render to WAV" for export |
| Win32 INI via `GetPrivateProfileStringA` | no Win32 | the pure-TS INI codec above (keeps file compatibility) |
| `ShellExecute` | replaced by `window.open` (popups must be user-initiated) | same URLs, opened from the menu click |

---

## 11. Fidelity pitfalls — reproduce or fix, but decide deliberately

1. **The FM sign quirk.** In the binary the FM branch tests the modulation factor: for a
   *negative* factor it negates the term (`fchs`) instead of offsetting the phase, i.e. it
   *replaces* the phase rather than adding to it. Reproduce the arithmetic exactly if you
   want bit-identical output; otherwise normalise it to `ph += fac * src` and note the change.
2. **`pow()` on negative bases.** The waveform tail is `sign(v) * |v|^cs2` precisely because
   `pow` of a negative base with a fractional exponent is NaN. Keep the sign dance.
3. **Order dependence.** Filters operate on the running mix, so reordering oscillators
   changes the sound. The tab order must therefore drive the render order.
4. **One-sample modulation latency.** A source oscillator that appears *later* in the list
   contributes its *previous* sample's `lastOut` to an earlier oscillator's FM/AM, because
   the mixer updates `lastOut` in list order within the same sample. The sequential loop
   reproduces this automatically; a parallel node graph would not.
5. **Inaudible oscillators still compute.** `enabled === 2` contributes nothing to the mix
   but still runs and still drives FM/AM — that is the whole point of the mode.
6. **Unison chaining is consumed once.** The `chained` flag is cleared the first time the
   slot is rendered; the phase/output inheritance happens exactly once.
7. **x87 80-bit intermediates.** The original computes in 80-bit x87 registers; JS uses
   IEEE-754 doubles. Differences are ~1e-16 relative — inaudible, but exports will not be
   bit-identical.
8. **WAV playback without interpolation.** The original truncates the phase to an integer
   frame index (no linear interpolation), which aliases. Keep it for parity; offer an
   interpolating variant as an option.
9. **The `+0x280` FM source index is not INI-serialised.** The INI stores `FMModBy` at
   `+0x27C`, while the mixer reads the FM source from `+0x280`; the UI (`FUN_00404800`) writes
   `+0x280`. So a song loaded from disk has an *uninitialised* FM source until the UI
   refresh runs. Reproduce the behaviour but sanitise it on load (`-1` = none) so the port
   does not read garbage.
10. **`StartT` unit ambiguity.** The engine treats it as milliseconds; the UI offers a
    beat:fraction display mode. Keep milliseconds canonical in the model and convert for
    display.

---

## 12. Suggested repository layout

```
src/
  model/
    oscillator.ts     # the 0x308-byte slot as TS types (model + derived state)
    ini.ts            # Win32-profile-compatible INI reader/writer
    store.ts          # song state, undo snapshots, dirty/saved flags
  dsp/
    engine.ts         # port of FUN_004081F0 (prepare)
    mixer.ts          # port of FUN_004083B0 (one sample)
    waveform.ts       # port of FUN_00407DB0
    noise.ts          # port of FUN_00407FD0 (deterministic PRNG)
    stomper-processor.ts   # AudioWorkletProcessor (registered as 'stomper-processor')
  audio/
    session.ts        # AudioContext, worklet node, live transport
    render.ts         # OfflineAudioContext render (FUN_004087F0)
    wav.ts            # 44-byte header writer (FUN_00408990)
    decode.ts         # WAV decode + mono downmix (FUN_00407FF0)
  ui/
    TabStrip.tsx      # FUN_00404A40
    OscList.tsx       # list control @ +0x31380
    ContextMenu.tsx   # RT_MENU 152
    Grid.tsx          # canvas envelope editors
    SubTabs.tsx       # Frequency / Amplitude / Waveshape|Cutoff
    Shortcuts.ts      # the 131 menu accelerators
    Notes.ts          # Hz <-> note conversion, snap grids
  export/
    stu.ts            # .STU/.STP serialisation
    wav-download.ts
```

Build: Vite + TypeScript; the worklet is a separate entry (`?worker`-style URL import) so it
can be served as a module and added with `audioWorklet.addModule()`; `OfflineAudioContext`
needs the same module added to its own worklet scope.

---

## 13. End-to-end flow (open → edit → hear → export)

1. **Open** — `showOpenFilePicker` → `loadSong(text)` → INI → `OscModel[]` →
   `prepareEngine()` → tabs rebuilt → canvas editors painted → `dirty = true`.
2. **Edit** — dragging a handle mutates one `OscModel` field → `push('edit')` (snapshot) →
   `prepareEngine()` → derived state `postMessage`d to the worklet → canvas repaint.
3. **Hear** — Preview starts the `AudioContext`; the worklet renders slot by slot; the
   "dirty" flag is cleared (the original cached a rendered `.wav`; the worklet makes that
   cache unnecessary — the equivalent is simply not re-initialising the state).
4. **Normalize** — offline render → peak scan → scale `startA`/`endA` → re-render → replay.
5. **Export** — offline render at `song.rate` → `encodeWav()` → download `.wav`; and
   `writeIni()` → download `.stu` (or save through the File System Access API).
