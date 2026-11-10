/**
 * The application shell: menu bar, tab strip, editor, parameter panel,
 * transport and status bar, plus the command table that maps the original's
 * command ids onto the web implementation.
 */

import { Playback } from './audio/session.ts';
import { normalizeSong, renderSong } from './audio/render.ts';
import { decodeSample } from './audio/decode.ts';
import { downloadBlob, encodeWav } from './audio/wav.ts';
import { createDefaultSong, createDemoSong } from './model/demo.ts';
import { iniFromSong, songFromIni } from './model/ini.ts';
import { Store, type AppState, type FreqDisplay, type SnapTime, type TimeDisplay } from './model/store.ts';
import { cloneOscillators, createOsc, createSong, type OscModel, type Song } from './model/types.ts';
import { buildContextMenu, type ContextMenuHost } from './ui/contextmenu.ts';
import { TimelineEditor } from './ui/editor.ts';
import { OscillatorList } from './ui/list.ts';
import { createMenubar, showContextMenu, type Menu, type MenuEntry } from './ui/menubar.ts';
import { ParamsPanel } from './ui/params.ts';
import { installShortcuts } from './ui/shortcuts.ts';
import { createTabs } from './ui/tabs.ts';

const SUB_TABS = ['Frequency', 'Amplitude', 'Shape'] as const;
const RATES = [22050, 44100, 48000];

interface FileHandleLike {
  name: string;
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
  getFile: () => Promise<File>;
}

interface FilePickerWindow {
  showSaveFilePicker?: (options: unknown) => Promise<FileHandleLike>;
  showOpenFilePicker?: (options: unknown) => Promise<FileHandleLike[]>;
}

export class App {
  private readonly store = new Store();
  private readonly playback = new Playback();
  /** Decoded PCM of the WAV files, keyed by oscillator index. */
  private readonly wavData = new Map<number, Float32Array>();
  /** Names of the decoded WAV files, keyed by oscillator index. */
  private readonly wavNames = new Map<number, string>();
  private clipboard: OscModel[] | null = null;
  private fileHandle: FileHandleLike | null = null;

  private tabs!: ReturnType<typeof createTabs>;
  private list!: OscillatorList;
  private params!: ParamsPanel;
  private editor!: TimelineEditor;
  private subTabBar!: HTMLElement;
  private transport!: HTMLElement;
  private statusBar!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private wavInput!: HTMLInputElement;

  constructor() {
    this.store.state.song = createDefaultSong();
  }

  // -------------------------------------------------------------------- mount

  mount(root: HTMLElement): void {
    root.innerHTML = '';

    const menubar = document.createElement('header');
    menubar.id = 'menubar';
    root.appendChild(menubar);

    const tabs = document.createElement('nav');
    tabs.id = 'tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Oscillators');
    root.appendChild(tabs);

    const main = document.createElement('main');
    main.id = 'main';
    root.appendChild(main);

    const work = document.createElement('section');
    work.className = 'work';
    main.appendChild(work);

    const subTabs = document.createElement('nav');
    subTabs.className = 'subtabs';
    subTabs.setAttribute('role', 'tablist');
    subTabs.setAttribute('aria-label', 'Parameter page');
    work.appendChild(subTabs);
    this.subTabBar = subTabs;

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = 'editor';
    canvas.setAttribute('aria-label', 'Envelope editor');
    canvasWrap.appendChild(canvas);
    work.appendChild(canvasWrap);

    const listWrap = document.createElement('section');
    listWrap.className = 'list-wrap';
    const listTitle = document.createElement('div');
    listTitle.className = 'list-title';
    listTitle.textContent = 'Oscillators';
    const list = document.createElement('ul');
    list.id = 'osclist';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Oscillator list');
    listWrap.append(listTitle, list);
    work.appendChild(listWrap);

    const params = document.createElement('aside');
    params.id = 'params';
    main.appendChild(params);

    const transport = document.createElement('section');
    transport.id = 'transport';
    root.appendChild(transport);
    this.transport = transport;

    const status = document.createElement('footer');
    status.id = 'status';
    root.appendChild(status);
    this.statusBar = status;

    // Hidden file inputs.
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.stu,.stp,.STU,.STP';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => void this.onFileChosen());
    root.appendChild(this.fileInput);

    this.wavInput = document.createElement('input');
    this.wavInput.type = 'file';
    this.wavInput.accept = 'audio/*,.wav';
    this.wavInput.hidden = true;
    this.wavInput.addEventListener('change', () => void this.onWavChosen());
    root.appendChild(this.wavInput);

    // Components.
    this.tabs = createTabs(
      tabs,
      (index) => this.store.select(index),
      () => this.addOscillator('after'),
    );
    this.list = new OscillatorList(list, {
      onSelect: (index) => this.store.select(index),
      onContextMenu: (index, x, y) => this.openContextMenu(index, x, y),
    });
    this.params = new ParamsPanel(params, this.store, {
      onCommit: (label, mutate) => this.commitOsc(label, mutate),
      onPickWav: () => this.wavInput.click(),
      onClearWav: () => this.clearWav(),
      wavName: (index) => this.wavNames.get(index) ?? '',
    });
    this.editor = new TimelineEditor(canvas, this.store);

    this.buildSubTabs();
    this.buildTransport();
    this.buildMenus();
    this.installShortcuts();

    this.store.subscribe((state, changed) => {
      if (changed.has('song') || changed.has('tab') || changed.has('subTab')) {
        this.tabs.update(state);
        this.list.update(state);
        this.params.update();
        this.editor.draw();
        this.updateStatus(state);
        this.updateTitle(state);
      }
      if (changed.has('message')) this.updateStatus(state);
      if (changed.has('playing')) this.updateTransport(state);
      if (changed.has('song') && this.playback.running) this.pushToPlayback();
    });

    window.addEventListener('resize', () => this.editor.draw());
    window.addEventListener('beforeunload', (event) => {
      if (this.store.state.song.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    // Restore the previous session if there is one.
    if (this.store.restoreAutosave()) {
      this.store.state.message = 'Restored the previous session.';
    }

    this.refreshAll();
  }

  private refreshAll(): void {
    const state = this.store.state;
    this.tabs.update(state);
    this.list.update(state);
    this.params.update();
    this.editor.draw();
    this.updateStatus(state);
    this.updateTitle(state);
    this.updateTransport(state);
  }

  // ------------------------------------------------------------------- chrome

  /** The current song as `.STU` text (the format written by FUN_004079A0). */
  toIni(): string {
    return iniFromSong(this.store.state.song);
  }

  private buildSubTabs(): void {
    this.subTabBar.innerHTML = '';
    SUB_TABS.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'subtab';
      button.textContent = label;
      button.addEventListener('click', () => {
        this.store.state.subTab = index as 0 | 1 | 2;
        this.store.touch('subTab');
      });
      this.subTabBar.appendChild(button);
    });
  }

  private buildTransport(): void {
    this.transport.innerHTML = '';

    const play = this.button('▶ Play', () => void this.togglePlay());
    play.id = 'play';
    const exportBtn = this.button('⬇ Export WAV', () => void this.exportWav());
    exportBtn.id = 'export';

    const rateBox = document.createElement('div');
    rateBox.className = 'rate-box';
    rateBox.appendChild(this.label('Sample rate'));
    for (const rate of RATES) {
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'rate';
      input.value = String(rate);
      input.addEventListener('change', () => {
        this.store.commit(`sample rate ${rate}`, (state) => {
          state.song.rate = rate;
        }, 'song');
      });
      const label = document.createElement('label');
      label.className = 'radio-label';
      label.append(input, document.createTextNode(String(rate)));
      rateBox.appendChild(label);
      input.dataset.rate = String(rate);
    }

    const tempoBox = document.createElement('div');
    tempoBox.className = 'tempo-box';
    tempoBox.appendChild(this.label('Tempo'));
    const tempo = document.createElement('input');
    tempo.type = 'number';
    tempo.min = '20';
    tempo.max = '400';
    tempo.step = '1';
    tempo.className = 'tempo-input';
    tempo.addEventListener('change', () => {
      const value = Number(tempo.value) || 120;
      this.store.state.tempo = value;
      this.store.touch('song');
      this.editor.draw();
    });
    tempoBox.appendChild(tempo);

    this.transport.append(play, exportBtn, rateBox, tempoBox);
    this.transport.dataset.role = 'transport';
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'transport-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  private label(text: string): HTMLElement {
    const span = document.createElement('span');
    span.className = 'field-label';
    span.textContent = text;
    return span;
  }

  private buildMenus(): void {
    const menus: Menu[] = [
      {
        label: 'File',
        entries: [
          { id: 0xe100, label: 'New', accel: 'Ctrl+N', run: () => this.newSong() },
          { id: 0xe101, label: 'Open…', accel: 'Ctrl+O', run: () => this.openDialog() },
          { id: 0xe103, label: 'Save', accel: 'Ctrl+S', run: () => void this.save(false) },
          { id: 0x8011, label: 'Save as…', run: () => void this.save(true) },
          { id: 0x8005, label: 'Exit', run: () => this.exitApp() },
        ],
      },
      {
        label: 'Edit',
        entries: [
          { id: 0xe12b, label: 'Undo', accel: 'Ctrl+Z', run: () => this.undo(), disabled: () => !this.store.canUndo() },
          { id: 0xe123, label: 'Cut', accel: 'Ctrl+X', run: () => this.cut() },
          { id: 0xe122, label: 'Copy', accel: 'Ctrl+C', run: () => this.copy() },
          { id: 0xe125, label: 'Paste', accel: 'Ctrl+V', run: () => this.paste(), disabled: () => !this.clipboard },
          { id: 0x8007, label: 'Insert Oscillator', accel: 'Ctrl+B', run: () => this.addOscillator('before') },
          { id: 0x8008, label: 'Delete Oscillator', run: () => this.removeOscillator() },
        ],
      },
      {
        label: 'Special',
        entries: [
          {
            label: 'Sample Frequency',
            submenu: RATES.map((rate, index) => ({
              id: 0x8029 + index,
              label: String(rate),
              run: () => this.setRate(rate),
              checked: () => this.store.state.song.rate === rate,
            })),
          },
          { id: 0x8027, label: 'Normalize', run: () => void this.normalize() },
          { id: 0x8028, label: 'Demo Song', run: () => this.loadDemo() },
          { id: 0x8014, label: 'Export WAV…', accel: 'Ctrl+E', run: () => void this.exportWav() },
        ],
      },
      {
        label: 'Web',
        entries: [
          { id: 0x8032, label: 'Get Latest Version', run: () => this.openLink('http://www.master-zap.com/stomper/') },
          { id: 0x8033, label: 'Stomper Sound Library', run: () => this.openLink('http://www.master-zap.com/stomper/') },
          { id: 0x8037, label: 'More software', run: () => this.openLink('http://www.master-zap.com/') },
          { id: 0x802f, label: 'Homepage', run: () => this.openLink('http://www.master-zap.com/stomper/') },
          { id: 0x8030, label: 'Music by the author', run: () => this.openLink('http://www.mp3.com/zap/') },
          { id: 0x8045, label: 'Stomper CHAT', run: () => this.openLink('http://www.master-zap.com/stomper/') },
        ],
      },
      {
        label: 'Help',
        entries: [
          {
            id: 0x803a,
            label: 'Heeeellp!!!!!',
            run: () => this.openLink('http://www.master-zap.com/stomper/documentation.html'),
          },
          { id: 0x0010, label: 'About Stomper Hyperion 5.0', run: () => this.showAbout() },
        ],
      },
    ];

    createMenubar(document.getElementById('menubar')!, menus);
  }

  private installShortcuts(): void {
    installShortcuts({
      newSong: () => this.newSong(),
      open: () => this.openDialog(),
      save: () => void this.save(false),
      undo: () => this.undo(),
      cut: () => this.cut(),
      copy: () => this.copy(),
      paste: () => this.paste(),
      mute: () => this.toggleMute(),
      addOscillator: () => this.addOscillator('after'),
      play: () => void this.togglePlay(),
      stop: () => void this.stopPlayback(),
      exportWav: () => void this.exportWav(),
    });
  }

  // ----------------------------------------------------------------- commands

  private newSong(): void {
    this.store.commit('new song', (state) => {
      state.song = createDefaultSong();
      state.tab = 0;
      state.subTab = 0;
    }, 'song', 'tab', 'subTab');
    this.wavData.clear();
    this.wavNames.clear();
    this.fileHandle = null;
    this.store.state.message = 'New song.';
  }

  private openDialog(): void {
    const picker = (window as unknown as FilePickerWindow).showOpenFilePicker;
    if (picker) {
      void picker
        .call(window, {
          types: [{ description: 'Stomper files', accept: { 'text/plain': ['.stu', '.stp'] } }],
          multiple: false,
        })
        .then(async (handles) => {
          const handle = handles[0];
          if (!handle) return;
          this.fileHandle = handle;
          await this.loadFile(await (await handle.getFile()).text(), handle.name);
        })
        .catch(() => undefined);
      return;
    }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private async onFileChosen(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (!file) return;
    this.fileHandle = null;
    await this.loadFile(await file.text(), file.name);
  }

  private async loadFile(text: string, name: string): Promise<void> {
    try {
      const song = songFromIni(text, name);
      this.store.commit(`open ${name}`, (state) => {
        state.song = song;
        state.tab = 0;
        state.subTab = 0;
      }, 'song', 'tab', 'subTab');
      this.wavData.clear();
      this.wavNames.clear();
      this.store.state.message = `Loaded ${name}.`;
      this.refreshAll();
    } catch (error) {
      this.store.state.message = `Could not load ${name}: ${(error as Error).message}`;
      this.store.touch('message');
    }
  }

  private async save(asNew: boolean): Promise<void> {
    const state = this.store.state;
    const text = iniFromSong(state.song);
    const name = state.song.filename || 'untitled.stu';

    const picker = (window as unknown as FilePickerWindow).showSaveFilePicker;
    if (picker && (asNew || !this.fileHandle)) {
      try {
        const handle = await picker.call(window, {
          suggestedName: asNew ? name : state.song.filename || 'untitled.stu',
          types: [{ description: 'Stomper file', accept: { 'text/plain': ['.stu'] } }],
        });
        this.fileHandle = handle;
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        this.store.state.song.filename = handle.name;
        this.store.state.song.dirty = false;
        this.store.state.song.saved = true;
        this.store.state.message = `Saved ${handle.name}.`;
        this.store.touch('song', 'message');
        return;
      } catch {
        /* the user cancelled the dialog — fall through to the download */
      }
    }

    if (this.fileHandle) {
      try {
        const writable = await this.fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        this.store.state.song.dirty = false;
        this.store.state.song.saved = true;
        this.store.state.message = `Saved ${this.fileHandle.name}.`;
        this.store.touch('song', 'message');
        return;
      } catch {
        this.fileHandle = null;
      }
    }

    downloadBlob(new Blob([text], { type: 'text/plain' }), name.endsWith('.stu') || name.endsWith('.stp') ? name : `${name}.stu`);
    this.store.state.song.dirty = false;
    this.store.state.song.saved = true;
    this.store.state.message = `Saved ${name}.`;
    this.store.touch('song', 'message');
  }

  private exitApp(): void {
    if (this.store.state.song.dirty) {
      const ok = window.confirm('Save the changes before closing Stomper?');
      if (ok) void this.save(false);
    }
    void this.stopPlayback();
    window.close();
  }

  private undo(): void {
    this.store.undo();
  }

  private copy(): void {
    const osc = this.store.current;
    if (!osc) return;
    this.clipboard = [{ ...osc }];
    this.store.state.message = 'Copied the oscillator.';
    this.store.touch('message');
    void this.writeClipboardText();
  }

  private cut(): void {
    const osc = this.store.current;
    if (!osc) return;
    this.clipboard = [{ ...osc }];
    this.removeOscillator();
  }

  private paste(): void {
    if (!this.clipboard || this.clipboard.length === 0) return;
    const copies = this.clipboard.map((o) => ({ ...o }));
    this.store.commit('paste oscillator', (state) => {
      const at = Math.min(state.tab + 1, state.song.oscillators.length);
      state.song.oscillators.splice(at, 0, ...copies);
      state.tab = at;
    }, 'song', 'tab');
  }

  private async writeClipboardText(): Promise<void> {
    if (!this.clipboard) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.clipboard, null, 2));
    } catch {
      /* clipboard permission denied — the in-memory clipboard still works */
    }
  }

  private addOscillator(where: 'before' | 'after'): void {
    this.store.commit('insert oscillator', (state) => {
      const at = where === 'before' ? state.tab : Math.min(state.tab + 1, state.song.oscillators.length);
      state.song.oscillators.splice(at, 0, createOsc());
      state.tab = at;
    }, 'song', 'tab');
  }

  private removeOscillator(): void {
    const index = this.store.state.tab;
    if (this.store.state.song.oscillators.length <= 1) {
      this.store.state.message = 'The last oscillator cannot be deleted.';
      this.store.touch('message');
      return;
    }
    this.store.commit('delete oscillator', (state) => {
      state.song.oscillators.splice(index, 1);
      // Re-index the WAV bindings and the modulation sources.
      const remap = new Map<number, Float32Array>();
      for (const [key, value] of this.wavData) {
        if (key === index) continue;
        remap.set(key > index ? key - 1 : key, value);
      }
      this.wavData.clear();
      for (const [key, value] of remap) this.wavData.set(key, value);
      const remapNames = new Map<number, string>();
      for (const [key, value] of this.wavNames) {
        if (key === index) continue;
        remapNames.set(key > index ? key - 1 : key, value);
      }
      this.wavNames.clear();
      for (const [key, value] of remapNames) this.wavNames.set(key, value);

      for (const osc of state.song.oscillators) {
        if (osc.fmSource === index) osc.fmSource = -1;
        else if (osc.fmSource > index) osc.fmSource -= 1;
        if (osc.amModBy === index) osc.amModBy = -1;
        else if (osc.amModBy > index) osc.amModBy -= 1;
      }
      state.tab = Math.max(0, Math.min(state.tab, state.song.oscillators.length - 1));
    }, 'song', 'tab');
  }

  private setEnabled(value: 0 | 1 | 2): void {
    this.commitOsc('change state', (osc) => {
      osc.enabled = value;
    });
  }

  private toggleMute(): void {
    const osc = this.store.current;
    if (!osc) return;
    this.setEnabled(osc.enabled === 0 ? 1 : 0);
  }

  private setRate(rate: number): void {
    this.store.commit(`sample rate ${rate}`, (state) => {
      state.song.rate = rate;
    }, 'song');
  }

  private commitOsc(label: string, mutate: (osc: OscModel) => void): void {
    this.store.commit(label, (state) => {
      const osc = state.song.oscillators[state.tab];
      if (osc) mutate(osc);
    }, 'song');
  }

  private loadDemo(): void {
    this.store.commit('demo song', (state) => {
      state.song = createDemoSong();
      state.tab = 0;
      state.subTab = 0;
    }, 'song', 'tab', 'subTab');
    this.wavData.clear();
    this.wavNames.clear();
    this.store.state.message = 'Loaded the built-in demo song.';
    this.store.touch('message');
  }

  private async normalize(): Promise<void> {
    const state = this.store.state;
    this.store.state.message = 'Normalizing…';
    this.store.touch('message');
    try {
      const result = await normalizeSong(state.song.oscillators, state.song.rate, this.wavArray());
      this.store.commit('normalize', (s) => {
        s.song.oscillators = cloneOscillators(state.song.oscillators);
      }, 'song');
      this.store.state.message = `Normalized (peak was ${result.peak.toFixed(3)}).`;
      this.store.touch('message');
    } catch (error) {
      this.store.state.message = `Normalize failed: ${(error as Error).message}`;
      this.store.touch('message');
    }
  }

  private async exportWav(): Promise<void> {
    const state = this.store.state;
    this.store.state.message = 'Rendering…';
    this.store.touch('message');
    try {
      const result = await renderSong(state.song.oscillators, state.song.rate, this.wavArray());
      const blob = encodeWav(result.samples, result.rate);
      const base = state.song.filename.replace(/\.(stu|stp)$/i, '') || 'stomper';
      downloadBlob(blob, `${base}.wav`);
      this.store.state.message = `Exported ${base}.wav (${result.frames} frames @ ${result.rate} Hz, peak ${result.peak.toFixed(3)}).`;
      this.store.touch('message');
    } catch (error) {
      this.store.state.message = `Export failed: ${(error as Error).message}`;
      this.store.touch('message');
    }
  }

  // ------------------------------------------------------------------ playback

  private async togglePlay(): Promise<void> {
    if (this.playback.running) {
      await this.stopPlayback();
      return;
    }
    try {
      // Natural end: close the context and flip the transport back to Play.
      this.playback.onended = () => {
        void this.stopPlayback();
      };
      await this.playback.start(this.store.state.song.oscillators, this.wavArray());
      this.store.state.playing = true;
      this.store.state.message = this.playback.fallback
        ? 'Playing (main-thread renderer — no AudioWorklet in this context).'
        : 'Playing.';
      this.store.touch('playing', 'message');
    } catch (error) {
      this.store.state.message = `Playback failed: ${(error as Error).message}`;
      this.store.touch('message');
    }
  }

  private async stopPlayback(): Promise<void> {
    this.playback.onended = null;
    await this.playback.stop();
    this.store.state.playing = false;
    this.store.state.message = 'Stopped.';
    this.store.touch('playing', 'message');
  }

  private pushToPlayback(): void {
    this.playback.update(this.store.state.song.oscillators, this.wavArray());
  }

  private wavArray(): (Float32Array | null)[] {
    return this.store.state.song.oscillators.map((_, index) => this.wavData.get(index) ?? null);
  }

  // ------------------------------------------------------------------ wav I/O

  private async onWavChosen(): Promise<void> {
    const file = this.wavInput.files?.[0];
    if (!file) return;
    const index = this.store.state.tab;
    try {
      const ctx = this.playback.context ?? new AudioContext();
      const decoded = await decodeSample(ctx, file);
      this.wavData.set(index, decoded.data);
      this.wavNames.set(index, decoded.name);
      this.commitOsc('load wav', (osc) => {
        osc.wavFile = decoded.name;
        osc.waveForm = 4;
      });
      this.store.state.message = `Loaded ${decoded.name} (${decoded.rate} Hz, ${decoded.data.length} frames).`;
      this.store.touch('message');
    } catch (error) {
      this.store.state.message = `Could not decode ${file.name}: ${(error as Error).message}`;
      this.store.touch('message');
    } finally {
      this.wavInput.value = '';
    }
  }

  private clearWav(): void {
    const index = this.store.state.tab;
    this.wavData.delete(index);
    this.wavNames.delete(index);
    this.commitOsc('clear wav', (osc) => {
      osc.wavFile = '';
      if (osc.waveForm === 4) osc.waveForm = 0;
    });
  }

  // ------------------------------------------------------------------- context

  private openContextMenu(index: number, x: number, y: number): void {
    this.store.select(index);
    const host: ContextMenuHost = {
      setEnabled: (value) => this.setEnabled(value),
      copy: () => this.copy(),
      cut: () => this.cut(),
      paste: () => this.paste(),
      remove: () => this.removeOscillator(),
      insertBefore: () => this.addOscillator('before'),
      insertAfter: () => this.addOscillator('after'),
      freqDisplay: () => this.store.state.freqDisplay,
      setFreqDisplay: (value) => this.setFreqDisplay(value),
      timeDisplay: () => this.store.state.timeDisplay,
      setTimeDisplay: (value) => this.setTimeDisplay(value),
      snapNote: () => this.store.state.snapNote,
      setSnapNote: (value) => this.setSnapNote(value),
      snapTime: () => this.store.state.snapTime,
      setSnapTime: (value) => this.setSnapTime(value),
      canPaste: () => this.clipboard !== null,
    };
    showContextMenu({ x, y }, buildContextMenu(host));
  }

  private setFreqDisplay(value: FreqDisplay): void {
    this.store.state.freqDisplay = value;
    this.store.touch('song');
    this.params.update();
    this.editor.draw();
  }

  private setTimeDisplay(value: TimeDisplay): void {
    this.store.state.timeDisplay = value;
    this.store.touch('song');
    this.params.update();
    this.editor.draw();
  }

  private setSnapNote(value: boolean): void {
    this.store.state.snapNote = value;
    this.store.touch('song');
  }

  private setSnapTime(value: SnapTime): void {
    this.store.state.snapTime = value;
    this.store.touch('song');
  }

  // -------------------------------------------------------------------- chrome

  private updateStatus(state: AppState): void {
    const length = this.store.songLength();
    const parts: string[] = [];
    parts.push(`Length ${length.toFixed(0)} ms`);
    parts.push(`Rate ${state.song.rate} Hz`);
    parts.push(`Tempo ${state.tempo} BPM`);
    parts.push(`Freq ${state.freqDisplay === 'note' ? 'Note' : 'Hz'}`);
    parts.push(`Time ${state.timeDisplay === 'beat' ? 'beat:fraction' : 'ms'}`);
    if (state.snapNote) parts.push('Snap note');
    if (state.snapTime) parts.push(`Snap 1-${state.snapTime}`);
    parts.push(`${state.song.oscillators.length} oscillator${state.song.oscillators.length === 1 ? '' : 's'}`);
    if (state.message) parts.push(state.message);
    this.statusBar.textContent = parts.join('   ·   ');

    // Sub tab selection.
    for (const [index, node] of Array.from(this.subTabBar.children).entries()) {
      node.classList.toggle('selected', index === state.subTab);
    }
  }

  private updateTitle(state: AppState): void {
    const name = state.song.filename || 'untitled';
    document.title = `${state.song.dirty ? '*' : ''}${name} — Stomper Hyperion 5.0`;
  }

  private updateTransport(state: AppState): void {
    const play = this.transport.querySelector<HTMLButtonElement>('#play');
    if (play) play.textContent = state.playing ? '■ Stop' : '▶ Play';
    for (const input of this.transport.querySelectorAll<HTMLInputElement>('input[name="rate"]')) {
      input.checked = Number(input.value) === state.song.rate;
    }
    const tempo = this.transport.querySelector<HTMLInputElement>('.tempo-input');
    if (tempo && document.activeElement !== tempo) tempo.value = String(state.tempo);
  }

  private showAbout(): void {
    const lines = [
      'Stomper Hyperion 5.0',
      'Version 5.01   build 54',
      '',
      'A web port of the 1999/2000 synthesizer STOMPER32.EXE.',
      'The sound engine, the oscillator model and the .STU/.STP file format',
      'were recovered from the original binary; the user interface was rebuilt',
      'with modern web technologies.',
      '',
      'No TUAREG plugin, no Zap News.',
    ];
    window.alert(lines.join('\n'));
  }

  private openLink(url: string): void {
    window.open(url, '_blank', 'noopener');
  }
}

export type { Song };
