/**
 * The envelope editor — the web version of the original's custom drawn grid
 * widgets (0x401E30 / 0x402970 / 0x401540 / 0x401640 / 0x401750 / 0x401980 /
 * 0x401A60).
 *
 * The original drew the frequency, amplitude and filter pages of the selected
 * oscillator over the song timeline and let the user drag the two envelope
 * points.  The shape is reproduced here with a canvas; the curve is drawn with
 * the very same pow() exponent the engine uses, so the picture and the sound
 * always agree.
 */

import { prepareEngine, TWO_PI } from '../dsp/engine.ts';
import { waveform } from '../dsp/waveform.ts';
import type { Store } from '../model/store.ts';
import type { OscModel } from '../model/types.ts';
import {
  formatFrequency,
  formatTime,
  freqToNoteName,
  midiToFreq,
  midiToNoteName,
  snapTime,
  snapToNote,
} from './units.ts';

type DragTarget = 'start' | 'end' | null;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const PAD = { left: 58, right: 14, top: 14, bottom: 26 };

export class TimelineEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly store: Store;
  private drag: DragTarget = null;
  private dragOffset = { x: 0, y: 0 };
  private lastPointer: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, store: Store) {
    this.canvas = canvas;
    this.store = store;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------------ drawing

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth || 600;
    const cssHeight = this.canvas.clientHeight || 240;
    if (this.canvas.width !== Math.floor(cssWidth * dpr) || this.canvas.height !== Math.floor(cssHeight * dpr)) {
      this.canvas.width = Math.floor(cssWidth * dpr);
      this.canvas.height = Math.floor(cssHeight * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const state = this.store.state;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const osc = this.store.current;
    if (!osc) {
      this.drawEmpty(ctx, cssWidth, cssHeight);
      return;
    }

    if (state.subTab === 2) {
      this.drawShape(ctx, cssWidth, cssHeight, osc);
      return;
    }

    const rect: Rect = {
      left: PAD.left,
      top: PAD.top,
      width: Math.max(10, cssWidth - PAD.left - PAD.right),
      height: Math.max(10, cssHeight - PAD.top - PAD.bottom),
    };

    const timeMax = Math.max(this.store.songLength(), this.store.maxEndT(), 1);
    const range = this.valueRange(osc);

    this.drawGrid(ctx, rect, timeMax, range);

    // Other oscillators first, so the selected one ends up on top.
    state.song.oscillators.forEach((other, index) => {
      if (index === state.tab) return;
      this.drawEnvelope(ctx, rect, other, timeMax, range, 'other');
    });
    this.drawEnvelope(ctx, rect, osc, timeMax, range, 'selected');
    this.drawHandles(ctx, rect, osc, timeMax, range);
  }

  private drawEmpty(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = '#7d8796';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No oscillator selected — press “New” to add one.', w / 2, h / 2);
  }

  private valueRange(osc: OscModel): { min: number; max: number } {
    const state = this.store.state;
    const values =
      state.subTab === 1
        ? [osc.startA, osc.endA]
        : [osc.startF, osc.endF];
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (state.subTab === 1) min = Math.min(min, 0);
    if (max - min < 1e-9) {
      max = min + 1;
    }
    const pad = (max - min) * 0.15;
    return { min: min - pad, max: max + pad };
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    timeMax: number,
    range: { min: number; max: number },
  ): void {
    const state = this.store.state;

    ctx.fillStyle = '#11151c';
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);

    // vertical time divisions
    const divisions = this.timeDivisions(timeMax);
    ctx.strokeStyle = '#1e2530';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const t of divisions) {
      const x = this.timeToX(rect, t, timeMax);
      ctx.beginPath();
      ctx.moveTo(x, rect.top);
      ctx.lineTo(x, rect.top + rect.height);
      ctx.stroke();
      ctx.fillStyle = '#6b7688';
      ctx.fillText(formatTime(t, state.timeDisplay, state.tempo), x, rect.top + rect.height + 14);
    }

    // horizontal value divisions
    const steps = 4;
    ctx.textAlign = 'right';
    for (let i = 0; i <= steps; i++) {
      const value = range.min + ((range.max - range.min) * i) / steps;
      const y = this.valueToY(rect, value, range);
      ctx.strokeStyle = '#1e2530';
      ctx.beginPath();
      ctx.moveTo(rect.left, y);
      ctx.lineTo(rect.left + rect.width, y);
      ctx.stroke();
      ctx.fillStyle = '#6b7688';
      const label =
        state.subTab === 1
          ? value.toFixed(2)
          : state.freqDisplay === 'note'
            ? midiToNoteName(Math.round(69 + 12 * Math.log2(Math.max(value, 1e-9) / 440)))
            : `${value.toFixed(value < 100 ? 1 : 0)}`;
      ctx.fillText(label, rect.left - 6, y + 3);
    }

    ctx.strokeStyle = '#2b3444';
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }

  private timeDivisions(timeMax: number): number[] {
    const state = this.store.state;
    const out: number[] = [];
    if (state.timeDisplay === 'beat') {
      const beat = 60000 / Math.max(1, state.tempo);
      const count = Math.min(32, Math.max(2, Math.ceil(timeMax / beat)));
      for (let i = 0; i <= count; i++) out.push(i * beat);
      return out;
    }
    const step = niceStep(timeMax / 8);
    for (let t = 0; t <= timeMax + 1e-6; t += step) out.push(t);
    return out;
  }

  private drawEnvelope(
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    osc: OscModel,
    timeMax: number,
    range: { min: number; max: number },
    kind: 'selected' | 'other',
  ): void {
    const state = this.store.state;
    const isAmp = state.subTab === 1;
    const startValue = isAmp ? osc.startA : osc.startF;
    const endValue = isAmp ? osc.endA : osc.endF;
    const exponent = isAmp ? osc.curveShape1 : osc.curveShape0;

    ctx.beginPath();
    const steps = 128;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const value = startValue + (endValue - startValue) * Math.pow(t, exponent);
      const time = osc.startT + (osc.endT - osc.startT) * t;
      const x = this.timeToX(rect, time, timeMax);
      const y = this.valueToY(rect, value, range);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    if (kind === 'selected') {
      ctx.strokeStyle = '#57b6ff';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(87,182,255,0.35)';
      ctx.shadowBlur = 6;
    } else {
      ctx.strokeStyle = osc.enabled === 0 ? '#39424f' : '#41505f';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 0;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Active span shading.
    if (osc.enabled !== 0) {
      const x0 = this.timeToX(rect, osc.startT, timeMax);
      const x1 = this.timeToX(rect, osc.endT, timeMax);
      ctx.fillStyle = kind === 'selected' ? 'rgba(87,182,255,0.07)' : 'rgba(255,255,255,0.02)';
      ctx.fillRect(x0, rect.top, Math.max(1, x1 - x0), rect.height);
    }
  }

  private drawHandles(
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    osc: OscModel,
    timeMax: number,
    range: { min: number; max: number },
  ): void {
    const state = this.store.state;
    const isAmp = state.subTab === 1;
    const points: [DragTarget, number, number][] = [
      ['start', osc.startT, isAmp ? osc.startA : osc.startF],
      ['end', osc.endT, isAmp ? osc.endA : osc.endF],
    ];
    for (const [, time, value] of points) {
      const x = this.timeToX(rect, time, timeMax);
      const y = this.valueToY(rect, value, range);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#e8edf5';
      ctx.fill();
      ctx.strokeStyle = '#57b6ff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  private drawShape(ctx: CanvasRenderingContext2D, w: number, h: number, osc: OscModel): void {
    const state = this.store.state;
    ctx.fillStyle = '#11151c';
    ctx.fillRect(PAD.left, PAD.top, Math.max(10, w - PAD.left - PAD.right), Math.max(10, h - PAD.top - PAD.bottom));

    const dsp = prepareEngine([osc], 22050, []);
    const period = osc.waveForm === 0 ? TWO_PI : 1;
    const width = Math.max(10, w - PAD.left - PAD.right);
    const height = Math.max(10, h - PAD.top - PAD.bottom);
    const mid = PAD.top + height / 2;

    ctx.strokeStyle = '#2b3444';
    ctx.beginPath();
    ctx.moveTo(PAD.left, mid);
    ctx.lineTo(PAD.left + width, mid);
    ctx.stroke();

    ctx.strokeStyle = '#57b6ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 256; i++) {
      const phase = (i / 256) * period;
      let v: number;
      try {
        v = waveform(dsp, 0, phase);
      } catch {
        v = 0;
      }
      const x = PAD.left + (i / 256) * width;
      const y = mid - v * (height / 2) * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#6b7688';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Waveform preview — ${['sine', 'triangle', 'square', 'saw', 'wav'][osc.waveForm] ?? 'unknown'}`, PAD.left + 8, PAD.top + 14);
    ctx.textAlign = 'right';
    ctx.fillText(`Curve shape exponent ${osc.curveShape2}`, w - PAD.right - 8, PAD.top + 14);
    ctx.textAlign = 'left';
  }

  // -------------------------------------------------------------- coordinates

  private timeToX(rect: Rect, time: number, timeMax: number): number {
    return rect.left + (time / timeMax) * rect.width;
  }

  private xToTime(rect: Rect, x: number, timeMax: number): number {
    return ((x - rect.left) / rect.width) * timeMax;
  }

  private valueToY(rect: Rect, value: number, range: { min: number; max: number }): number {
    const t = (value - range.min) / (range.max - range.min || 1);
    return rect.top + rect.height - t * rect.height;
  }

  private yToValue(rect: Rect, y: number, range: { min: number; max: number }): number {
    const t = (rect.top + rect.height - y) / rect.height;
    return range.min + t * (range.max - range.min);
  }

  private pointerPos(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private plotRect(): Rect {
    const w = this.canvas.clientWidth || 600;
    const h = this.canvas.clientHeight || 240;
    return {
      left: PAD.left,
      top: PAD.top,
      width: Math.max(10, w - PAD.left - PAD.right),
      height: Math.max(10, h - PAD.top - PAD.bottom),
    };
  }

  // -------------------------------------------------------------- interaction

  private onPointerDown = (event: PointerEvent): void => {
    const state = this.store.state;
    const osc = this.store.current;
    if (!osc || state.subTab === 2) return;

    const rect = this.plotRect();
    const timeMax = Math.max(this.store.songLength(), this.store.maxEndT(), 1);
    const range = this.valueRange(osc);
    const { x, y } = this.pointerPos(event);

    const isAmp = state.subTab === 1;
    const candidates: [DragTarget, number, number][] = [
      ['start', osc.startT, isAmp ? osc.startA : osc.startF],
      ['end', osc.endT, isAmp ? osc.endA : osc.endF],
    ];

    let best: DragTarget = null;
    let bestDistance = 14;
    for (const [target, time, value] of candidates) {
      const hx = this.timeToX(rect, time, timeMax);
      const hy = this.valueToY(rect, value, range);
      const d = Math.hypot(hx - x, hy - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = target;
      }
    }
    if (!best) return;

    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = best;
    this.lastPointer = { x, y };
    this.store.begin(best === 'start' ? 'edit start point' : 'edit end point');
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    const osc = this.store.current;
    if (!osc) return;

    const state = this.store.state;
    const rect = this.plotRect();
    const timeMax = Math.max(this.store.songLength(), this.store.maxEndT(), 1);
    const range = this.valueRange(osc);
    const { x, y } = this.pointerPos(event);
    this.lastPointer = { x, y };

    let time = this.xToTime(rect, x, timeMax);
    let value = this.yToValue(rect, y, range);

    // Snapping (menu 152).
    if (state.snapTime) time = snapTime(time, state.snapTime, state.tempo);
    if (state.snapNote && state.subTab === 0) value = snapToNote(value);
    time = Math.max(0, time);

    const isAmp = state.subTab === 1;
    this.store.live((s) => {
      const target = s.song.oscillators[s.tab];
      if (!target) return;
      if (this.drag === 'start') {
        target.startT = time;
        if (isAmp) target.startA = value;
        else target.startF = value;
      } else {
        target.endT = time;
        if (isAmp) target.endA = value;
        else target.endF = value;
      }
    }, 'song');
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.drag = null;
    this.lastPointer = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.store.end();
  };
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 100;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const n = raw / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

export { formatFrequency, freqToNoteName, midiToFreq };
