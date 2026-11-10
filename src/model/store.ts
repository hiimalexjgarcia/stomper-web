/**
 * Application state, undo/redo and persistence.
 *
 * The original kept a single 0x18400 byte snapshot at dialog+0x18E00 and a
 * chain of undo records at dialog+0x98; FUN_004059E0 cleared the chain and
 * copied the model into the snapshot, FUN_00405870 restored it.  The web port
 * keeps the same snapshot payload but stores a proper stack, so the user can
 * undo more than one step.
 */

import { cloneOscillators, createSong, type OscModel, type Song } from './types.ts';

export type SubTab = 0 | 1 | 2; // Frequency | Amplitude | Shape
export type FreqDisplay = 'hz' | 'note';
export type TimeDisplay = 'ms' | 'beat';
export type SnapTime = 0 | 4 | 8 | 16 | 32; // 0 = none, otherwise 1/4 .. 1/32 note

export interface AppState {
  song: Song;
  /** selected oscillator (dialog+0x31204) */
  tab: number;
  /** selected sub page (dialog+0x31208) */
  subTab: SubTab;
  freqDisplay: FreqDisplay;
  timeDisplay: TimeDisplay;
  snapNote: boolean;
  snapTime: SnapTime;
  /** tempo used by the beat:fraction display and the time snapping */
  tempo: number;
  playing: boolean;
  status: string;
  /** transient message shown in the status bar */
  message: string;
}

interface Snapshot {
  song: Song;
  tab: number;
  subTab: SubTab;
  label: string;
}

export type Listener = (state: AppState, changed: Set<keyof AppState>) => void;

const AUTOSAVE_KEY = 'stomper.autosave.v1';

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private pending = new Set<keyof AppState>();

  constructor(initial?: Partial<AppState>) {
    this.state = {
      song: createSong(),
      tab: 0,
      subTab: 0,
      freqDisplay: 'hz',
      timeDisplay: 'ms',
      snapNote: false,
      snapTime: 0,
      tempo: 120,
      playing: false,
      status: 'Ready',
      message: '',
      ...initial,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mark parts of the state as changed and notify the subscribers. */
  emit(...changed: (keyof AppState)[]): void {
    for (const key of changed) this.pending.add(key);
    const snapshot = new Set(this.pending);
    this.pending.clear();
    for (const fn of this.listeners) fn(this.state, snapshot);
  }

  private snapshot(label: string): Snapshot {
    return {
      song: { ...this.state.song, oscillators: cloneOscillators(this.state.song.oscillators) },
      tab: this.state.tab,
      subTab: this.state.subTab,
      label,
    };
  }

  /**
   * Apply a destructive change, remembering the previous state so it can be
   * undone (the web equivalent of FUN_004059E0).
   */
  commit(label: string, mutator: (state: AppState) => void, ...changed: (keyof AppState)[]): void {
    this.begin(label);
    this.live(mutator, ...(changed.length ? changed : (['song', 'tab'] as (keyof AppState)[])));
    this.end();
  }

  /**
   * Start a continuous interaction (a drag).  The snapshot is taken once, at
   * the beginning of the gesture, so the whole drag is a single undo step.
   */
  begin(label: string): void {
    this.undoStack.push(this.snapshot(label));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Mutate without touching the undo stack. */
  live(mutator: (state: AppState) => void, ...changed: (keyof AppState)[]): void {
    mutator(this.state);
    this.state.song.dirty = true;
    this.state.song.saved = false;
    this.emit(...(changed.length ? changed : (['song'] as (keyof AppState)[])));
  }

  /** Finish a continuous interaction. */
  end(): void {
    this.emit('song');
    this.autosave();
  }

  /** Non destructive change (selection, display mode, ...). */
  touch(...changed: (keyof AppState)[]): void {
    this.emit(...changed);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.snapshot(snap.label));
    this.state.song = snap.song;
    this.state.tab = Math.min(snap.tab, Math.max(0, snap.song.oscillators.length - 1));
    this.state.subTab = snap.subTab;
    this.state.message = `Undo ${snap.label}`;
    this.emit('song', 'tab', 'subTab', 'message');
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot(snap.label));
    this.state.song = snap.song;
    this.state.tab = Math.min(snap.tab, Math.max(0, snap.song.oscillators.length - 1));
    this.state.subTab = snap.subTab;
    this.state.message = `Redo ${snap.label}`;
    this.emit('song', 'tab', 'subTab', 'message');
  }

  // ---------------------------------------------------------------- helpers

  get oscillators(): OscModel[] {
    return this.state.song.oscillators;
  }

  get current(): OscModel | null {
    return this.state.song.oscillators[this.state.tab] ?? null;
  }

  select(tab: number): void {
    const clamped = Math.max(0, Math.min(this.state.song.oscillators.length - 1, tab));
    if (clamped === this.state.tab) return;
    this.state.tab = clamped;
    this.emit('tab');
  }

  /** Song length in milliseconds: the longest enabled oscillator (FUN_004080E0). */
  songLength(): number {
    let max = 0;
    for (const o of this.state.song.oscillators) {
      if (o.enabled !== 0 && o.endT > max) max = o.endT;
    }
    return max;
  }

  /** Longest oscillator regardless of the enabled flag (FUN_00404540). */
  maxEndT(): number {
    let max = 0;
    for (const o of this.state.song.oscillators) if (o.endT > max) max = o.endT;
    return max;
  }

  // ------------------------------------------------------------ persistence

  autosave(): void {
    try {
      const payload = {
        oscillators: this.state.song.oscillators,
        rate: this.state.song.rate,
        filename: this.state.song.filename,
        tempo: this.state.tempo,
      };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
    } catch {
      /* storage disabled — ignore */
    }
  }

  restoreAutosave(): boolean {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as {
        oscillators?: OscModel[];
        rate?: number;
        filename?: string;
        tempo?: number;
      };
      if (!Array.isArray(data.oscillators) || data.oscillators.length === 0) return false;
      this.state.song = {
        ...this.state.song,
        oscillators: data.oscillators.map((o) => ({ ...o })),
        rate: data.rate ?? this.state.song.rate,
        filename: data.filename ?? '',
      };
      if (data.tempo) this.state.tempo = data.tempo;
      return true;
    } catch {
      return false;
    }
  }

  clearAutosave(): void {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
  }
}
