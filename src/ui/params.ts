/**
 * Parameter panel.
 *
 * The original showed the selected slot's parameters in the dialog's right
 * hand column, split over three sub pages (Frequency / Amplitude /
 * "Waveshape | Cutoff F | Resonance").  The web port keeps the same three
 * pages, driven by `state.subTab`.
 */

import type { Store } from '../model/store.ts';
import { ENABLED_NAMES, ROLE_NAMES, WAVE_NAMES, type OscModel } from '../model/types.ts';
import { formatFrequency, formatNumber, formatTime, parseFrequency, parseTime } from './units.ts';

export interface ParamsHost {
  /** A discrete edit: one undo step. */
  onCommit(label: string, mutate: (osc: OscModel) => void): void;
  /** Pick a WAV file for the selected oscillator. */
  onPickWav(): void;
  /** Forget the WAV file of the selected oscillator. */
  onClearWav(): void;
  /** Name of the WAV file currently bound to an oscillator ("" when none). */
  wavName(index: number): string;
}

interface Field {
  input: HTMLInputElement | HTMLSelectElement;
  /** Write the model value into the widget. */
  write: (osc: OscModel) => void;
  /** Read the widget back into the model. */
  read: (osc: OscModel) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ParamsPanel {
  private readonly container: HTMLElement;
  private readonly store: Store;
  private readonly host: ParamsHost;
  private fields: Field[] = [];
  private sections = new Map<number, HTMLElement>();
  private enabledInputs: HTMLInputElement[] = [];
  private roleInputs: HTMLInputElement[] = [];
  private waveSelect!: HTMLSelectElement;
  private loopCheck!: HTMLInputElement;
  private commentInput!: HTMLInputElement;
  private wavLabel!: HTMLElement;
  private fmSelect!: HTMLSelectElement;
  private amSelect!: HTMLSelectElement;

  constructor(container: HTMLElement, store: Store, host: ParamsHost) {
    this.container = container;
    this.store = store;
    this.host = host;
    this.build();
  }

  // ---------------------------------------------------------------- building

  private build(): void {
    this.container.innerHTML = '';
    this.container.className = 'params';

    this.container.appendChild(this.buildGeneral());
    this.container.appendChild(this.buildFrequency());
    this.container.appendChild(this.buildAmplitude());
    this.container.appendChild(this.buildShape());
    this.container.appendChild(this.buildTiming());
  }

  private section(key: number, title: string): HTMLElement {
    const fieldset = el('fieldset', 'panel-group');
    fieldset.appendChild(el('legend', undefined, title));
    this.sections.set(key, fieldset);
    return fieldset;
  }

  private row(parent: HTMLElement, label: string): HTMLDivElement {
    const row = el('div', 'field');
    const labelEl = el('label', 'field-label', label);
    row.appendChild(labelEl);
    parent.appendChild(row);
    return row;
  }

  private textField(
    parent: HTMLElement,
    label: string,
    options: {
      read: (text: string, osc: OscModel) => void;
      write: (osc: OscModel) => string;
      title?: string;
    },
  ): HTMLInputElement {
    const row = this.row(parent, label);
    const input = el('input', 'field-input');
    input.type = 'text';
    input.spellcheck = false;
    if (options.title) input.title = options.title;
    input.addEventListener('change', () => {
      const osc = this.store.current;
      if (!osc) return;
      this.host.onCommit(`change ${label}`, (target) => options.read(input.value, target));
    });
    row.appendChild(input);
    this.fields.push({
      input,
      write: (osc) => {
        if (document.activeElement !== input) input.value = options.write(osc);
      },
      read: (osc) => options.read(input.value, osc),
    });
    return input;
  }

  private numberField(
    parent: HTMLElement,
    label: string,
    options: { get: (osc: OscModel) => number; set: (osc: OscModel, v: number) => void; digits?: number; title?: string },
  ): HTMLInputElement {
    return this.textField(parent, label, {
      read: (text, osc) => options.set(osc, Number.parseFloat(text) || 0),
      write: (osc) => formatNumber(options.get(osc), options.digits ?? 4),
      title: options.title,
    });
  }

  private selectField(
    parent: HTMLElement,
    label: string,
    options: { choices: (osc: OscModel) => { value: string; label: string }[]; get: (osc: OscModel) => string; set: (osc: OscModel, v: string) => void },
  ): HTMLSelectElement {
    const row = this.row(parent, label);
    const select = el('select', 'field-input');
    select.addEventListener('change', () => {
      const osc = this.store.current;
      if (!osc) return;
      this.host.onCommit(`change ${label}`, (target) => options.set(target, select.value));
    });
    row.appendChild(select);
    this.fields.push({
      input: select,
      write: (osc) => {
        const choices = options.choices(osc);
        select.innerHTML = '';
        for (const choice of choices) {
          const option = el('option', undefined, choice.label);
          option.value = choice.value;
          select.appendChild(option);
        }
        select.value = options.get(osc);
      },
      read: (osc) => options.set(osc, select.value),
    });
    return select;
  }

  private buildGeneral(): HTMLElement {
    const section = this.section(-1, 'Oscillator');

    // On / Off / Inaudible (dialog radios 0x40C / 0x40D / 0x40E).
    const enabledRow = this.row(section, 'State');
    const enabledBox = el('div', 'radio-row');
    ENABLED_NAMES.forEach((name, index) => {
      const input = el('input');
      input.type = 'radio';
      input.name = 'enabled';
      input.value = String(index);
      input.addEventListener('change', () => {
        const osc = this.store.current;
        if (!osc) return;
        this.host.onCommit('change state', (target) => {
          target.enabled = index as OscModel['enabled'];
        });
      });
      this.enabledInputs.push(input);
      const label = el('label', 'radio-label');
      label.append(input, document.createTextNode(name));
      enabledBox.appendChild(label);
    });
    enabledRow.appendChild(enabledBox);

    // Oscillator / Filter (dialog radios 0x410 / 0x411).
    const roleRow = this.row(section, 'Type');
    const roleBox = el('div', 'radio-row');
    ROLE_NAMES.forEach((name, index) => {
      const input = el('input');
      input.type = 'radio';
      input.name = 'role';
      input.value = String(index);
      input.addEventListener('change', () => {
        const osc = this.store.current;
        if (!osc) return;
        this.host.onCommit('change type', (target) => {
          target.role = index as OscModel['role'];
        });
      });
      this.roleInputs.push(input);
      const label = el('label', 'radio-label');
      label.append(input, document.createTextNode(name));
      roleBox.appendChild(label);
    });
    roleRow.appendChild(roleBox);

    this.waveSelect = this.selectField(section, 'Waveform', {
      choices: () => WAVE_NAMES.map((name, index) => ({ value: String(index), label: name })),
      get: (osc) => String(osc.waveForm),
      set: (osc, value) => {
        osc.waveForm = Number(value) as OscModel['waveForm'];
      },
    });

    const loopRow = this.row(section, 'Loop WAV');
    this.loopCheck = el('input', 'field-input');
    this.loopCheck.type = 'checkbox';
    this.loopCheck.addEventListener('change', () => {
      const osc = this.store.current;
      if (!osc) return;
      this.host.onCommit('change loop', (target) => {
        target.loopWav = this.loopCheck.checked ? 1 : 0;
      });
    });
    loopRow.appendChild(this.loopCheck);

    const wavRow = this.row(section, 'WAV file');
    const wavBox = el('div', 'field-inline');
    this.wavLabel = el('span', 'wav-name', '(none)');
    const pick = el('button', 'mini-button', 'Choose…');
    pick.type = 'button';
    pick.addEventListener('click', () => this.host.onPickWav());
    const clear = el('button', 'mini-button', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => this.host.onClearWav());
    wavBox.append(this.wavLabel, pick, clear);
    wavRow.appendChild(wavBox);

    const commentRow = this.row(section, 'Comment');
    this.commentInput = el('input', 'field-input');
    this.commentInput.type = 'text';
    this.commentInput.maxLength = 250;
    this.commentInput.addEventListener('change', () => {
      const osc = this.store.current;
      if (!osc) return;
      this.host.onCommit('change comment', (target) => {
        target.comment = this.commentInput.value.slice(0, 250);
      });
    });
    commentRow.appendChild(this.commentInput);
    this.fields.push({
      input: this.commentInput,
      write: (osc) => {
        if (document.activeElement !== this.commentInput) this.commentInput.value = osc.comment;
      },
      read: () => undefined,
    });

    return section;
  }

  private buildFrequency(): HTMLElement {
    const section = this.section(0, 'Frequency');
    const state = this.store.state;

    this.textField(section, 'Start', {
      read: (text, osc) => {
        osc.startF = parseFrequency(text, this.store.state.freqDisplay);
      },
      write: (osc) => formatFrequency(osc.startF, this.store.state.freqDisplay),
      title: 'Start frequency',
    });
    this.textField(section, 'End', {
      read: (text, osc) => {
        osc.endF = parseFrequency(text, this.store.state.freqDisplay);
      },
      write: (osc) => formatFrequency(osc.endF, this.store.state.freqDisplay),
      title: 'End frequency',
    });
    this.numberField(section, 'Curve', {
      get: (osc) => osc.curveShape0,
      set: (osc, v) => {
        osc.curveShape0 = v;
      },
      title: 'CurveShape0 — exponent of the timing curve',
    });

    this.fmSelect = this.selectField(section, 'FM by', {
      choices: () => this.sourceChoices(),
      get: (osc) => String(osc.fmSource),
      set: (osc, value) => {
        osc.fmSource = Number(value);
        osc.fmModBy = osc.fmSource;
      },
    });
    this.numberField(section, 'FM factor', {
      get: (osc) => osc.fmModFac,
      set: (osc, v) => {
        osc.fmModFac = v;
      },
      title: 'FMModFac — how strongly the source modulates the phase',
    });
    void state;
    return section;
  }

  private buildAmplitude(): HTMLElement {
    const section = this.section(1, 'Amplitude');
    this.numberField(section, 'Start', {
      get: (osc) => osc.startA,
      set: (osc, v) => {
        osc.startA = v;
      },
    });
    this.numberField(section, 'End', {
      get: (osc) => osc.endA,
      set: (osc, v) => {
        osc.endA = v;
      },
    });
    this.numberField(section, 'Curve', {
      get: (osc) => osc.curveShape1,
      set: (osc, v) => {
        osc.curveShape1 = v;
      },
      title: 'CurveShape1 — exponent of the amplitude curve',
    });
    this.amSelect = this.selectField(section, 'AM by', {
      choices: () => this.sourceChoices(),
      get: (osc) => String(osc.amModBy),
      set: (osc, value) => {
        osc.amModBy = Number(value);
      },
    });
    this.numberField(section, 'AM factor', {
      get: (osc) => osc.amModFac,
      set: (osc, v) => {
        osc.amModFac = v;
      },
      title: 'AMModFac — how strongly the source modulates the amplitude',
    });
    return section;
  }

  private buildShape(): HTMLElement {
    const section = this.section(2, 'Shape');
    this.numberField(section, 'Curve 2', {
      get: (osc) => osc.curveShape2,
      set: (osc, v) => {
        osc.curveShape2 = v;
      },
      title: 'CurveShape2 — exponent applied to the generated waveform',
    });
    this.numberField(section, 'Noise BW', {
      get: (osc) => osc.noiseBW,
      set: (osc, v) => {
        osc.noiseBW = v;
      },
      title: 'Noise bandwidth — random phase modulation',
    });
    this.numberField(section, 'Noise rate', {
      get: (osc) => osc.noiseChangeRate,
      set: (osc, v) => {
        osc.noiseChangeRate = v;
      },
      digits: 0,
      title: 'How many samples the noise value is held for',
    });
    return section;
  }

  private buildTiming(): HTMLElement {
    const section = this.section(-2, 'Timing');
    this.textField(section, 'Start', {
      read: (text, osc) => {
        osc.startT = parseTime(text, this.store.state.timeDisplay, this.store.state.tempo);
      },
      write: (osc) => formatTime(osc.startT, this.store.state.timeDisplay, this.store.state.tempo),
      title: 'Start time',
    });
    this.textField(section, 'End', {
      read: (text, osc) => {
        osc.endT = parseTime(text, this.store.state.timeDisplay, this.store.state.tempo);
      },
      write: (osc) => formatTime(osc.endT, this.store.state.timeDisplay, this.store.state.tempo),
      title: 'End time',
    });

    const lengthRow = this.row(section, 'Length');
    const length = el('span', 'field-static', '0 ms');
    lengthRow.appendChild(length);
    this.fields.push({
      input: el('input'),
      write: (osc) => {
        length.textContent = formatTime(osc.endT - osc.startT, this.store.state.timeDisplay, this.store.state.tempo);
      },
      read: () => undefined,
    });
    return section;
  }

  private sourceChoices(): { value: string; label: string }[] {
    const choices = [{ value: '-1', label: 'None' }];
    this.store.state.song.oscillators.forEach((osc, index) => {
      const name = osc.comment ? ` — ${osc.comment}` : '';
      choices.push({ value: String(index), label: `${index}${name}` });
    });
    return choices;
  }

  // ---------------------------------------------------------------- updating

  update(): void {
    const state = this.store.state;
    const osc = this.store.current;
    const enabled = osc !== null;

    for (const [, node] of this.sections) node.classList.toggle('hidden', false);

    // Only the page selected by the sub tab strip is visible, plus the
    // always-on "Oscillator" and "Timing" groups.
    const general = this.sections.get(-1)!;
    const timing = this.sections.get(-2)!;
    general.classList.remove('hidden');
    timing.classList.remove('hidden');
    for (const [key, node] of this.sections) {
      if (key >= 0) node.classList.toggle('hidden', key !== state.subTab);
    }

    for (const field of this.fields) {
      if (!enabled) {
        if (field.input instanceof HTMLInputElement && field.input.type !== 'checkbox') field.input.value = '';
        continue;
      }
      field.write(osc);
    }

    this.enabledInputs.forEach((input, index) => {
      input.checked = enabled && osc!.enabled === index;
      input.disabled = !enabled;
    });
    this.roleInputs.forEach((input, index) => {
      input.checked = enabled && osc!.role === index;
      input.disabled = !enabled;
    });

    this.wavLabel.textContent = enabled && osc!.wavFile ? osc!.wavFile : '(none)';
    this.wavLabel.classList.toggle('missing', Boolean(enabled && osc!.wavFile && !this.host.wavName(state.tab)));
  }
}
