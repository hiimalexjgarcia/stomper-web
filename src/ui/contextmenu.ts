/**
 * Context menu of the oscillator list (RT_MENU 152).
 *
 * The original menu carried the command ids
 *
 *   On 0x801E · Off 0x801F · Inaudible 0x8020
 *   Copy 0xE122 · Cut 0xE123 · Paste 0xE125 · Delete 0x8008
 *   Insert Before 0x8007 · Insert After 0x8017
 *   Display mode  Hz 0x803B / Note 0x803C / Snap to note 0x803D
 *   Display mode  milliseconds 0x803E / beat:fraction 0x803F
 *   Snap to time  none 0x8044 / 1-4 0x8040 / 1-8 0x8041 / 1-16 0x8042 / 1-32 0x8043
 *
 * The web port rebuilds the same menu on top of the shared menu widget.
 */

import type { FreqDisplay, SnapTime, TimeDisplay } from '../model/store.ts';
import type { MenuEntry } from './menubar.ts';

export interface ContextMenuHost {
  setEnabled(value: 0 | 1 | 2): void;
  copy(): void;
  cut(): void;
  paste(): void;
  remove(): void;
  insertBefore(): void;
  insertAfter(): void;
  freqDisplay(): FreqDisplay;
  setFreqDisplay(value: FreqDisplay): void;
  timeDisplay(): TimeDisplay;
  setTimeDisplay(value: TimeDisplay): void;
  snapNote(): boolean;
  setSnapNote(value: boolean): void;
  snapTime(): SnapTime;
  setSnapTime(value: SnapTime): void;
  canPaste(): boolean;
}

export function buildContextMenu(host: ContextMenuHost): MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: 0x801e, label: 'On', run: () => host.setEnabled(1) },
    { id: 0x801f, label: 'Off', run: () => host.setEnabled(0) },
    { id: 0x8020, label: 'Inaudible', run: () => host.setEnabled(2) },
    { id: 0xe122, label: 'Copy', run: () => host.copy() },
    { id: 0xe123, label: 'Cut', run: () => host.cut() },
    { id: 0xe125, label: 'Paste', run: () => host.paste(), disabled: () => !host.canPaste() },
    { id: 0x8008, label: 'Delete', run: () => host.remove() },
    { id: 0x8007, label: 'Insert Before', run: () => host.insertBefore() },
    { id: 0x8017, label: 'Insert After', run: () => host.insertAfter() },
    {
      label: 'Display mode',
      submenu: [
        {
          id: 0x803b,
          label: 'Hz',
          run: () => host.setFreqDisplay('hz'),
          checked: () => host.freqDisplay() === 'hz',
        },
        {
          id: 0x803c,
          label: 'Note',
          run: () => host.setFreqDisplay('note'),
          checked: () => host.freqDisplay() === 'note',
        },
        {
          id: 0x803d,
          label: 'Snap to note',
          run: () => host.setSnapNote(!host.snapNote()),
          checked: () => host.snapNote(),
        },
      ],
    },
    {
      label: 'Display mode',
      submenu: [
        {
          id: 0x803e,
          label: 'milliseconds',
          run: () => host.setTimeDisplay('ms'),
          checked: () => host.timeDisplay() === 'ms',
        },
        {
          id: 0x803f,
          label: 'beat:fraction',
          run: () => host.setTimeDisplay('beat'),
          checked: () => host.timeDisplay() === 'beat',
        },
      ],
    },
    {
      label: 'Snap to time',
      submenu: [
        { id: 0x8044, label: 'none', run: () => host.setSnapTime(0), checked: () => host.snapTime() === 0 },
        { id: 0x8040, label: '1-4', run: () => host.setSnapTime(4), checked: () => host.snapTime() === 4 },
        { id: 0x8041, label: '1-8', run: () => host.setSnapTime(8), checked: () => host.snapTime() === 8 },
        { id: 0x8042, label: '1-16', run: () => host.setSnapTime(16), checked: () => host.snapTime() === 16 },
        { id: 0x8043, label: '1-32', run: () => host.setSnapTime(32), checked: () => host.snapTime() === 32 },
      ],
    },
  ];

  return entries;
}
