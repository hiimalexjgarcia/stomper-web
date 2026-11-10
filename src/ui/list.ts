/**
 * Oscillator list control (dialog +0x31380 in the original).
 *
 * The list shows every slot in order, the way the original's list control did,
 * and carries the rich context menu (RT_MENU 152) on the right mouse button.
 */

import type { AppState } from '../model/store.ts';
import { ROLE_NAMES } from '../model/types.ts';

export interface ListHost {
  onSelect(index: number): void;
  onContextMenu(index: number, x: number, y: number): void;
}

export class OscillatorList {
  private readonly container: HTMLElement;
  private readonly host: ListHost;

  constructor(container: HTMLElement, host: ListHost) {
    this.container = container;
    this.host = host;
    container.innerHTML = '';
    container.className = 'osc-list';
  }

  update(state: AppState): void {
    const list = this.container;
    const wanted = state.song.oscillators.length;

    while (list.children.length > wanted) list.lastElementChild?.remove();
    while (list.children.length < wanted) {
      const item = document.createElement('li');
      item.className = 'osc-item';
      item.setAttribute('role', 'option');
      item.addEventListener('click', () => {
        this.host.onSelect(Number(item.dataset.index ?? '0'));
      });
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const index = Number(item.dataset.index ?? '0');
        this.host.onSelect(index);
        this.host.onContextMenu(index, event.clientX, event.clientY);
      });
      list.appendChild(item);
    }

    state.song.oscillators.forEach((osc, index) => {
      const item = list.children[index] as HTMLLIElement;
      item.dataset.index = String(index);
      const stateClass = osc.enabled === 0 ? 'off' : osc.enabled === 2 ? 'inaudible' : 'on';
      const role = osc.role === 0 ? '' : ` ${ROLE_NAMES[osc.role]}`;
      item.className = `osc-item ${stateClass}${state.tab === index ? ' selected' : ''}`;
      item.setAttribute('aria-selected', String(state.tab === index));
      item.innerHTML = '';
      const badge = document.createElement('span');
      badge.className = 'osc-badge';
      badge.textContent = String(index);
      const comment = document.createElement('span');
      comment.className = 'osc-comment';
      comment.textContent = osc.comment || (osc.role === 0 ? 'oscillator' : ROLE_NAMES[osc.role]!);
      const meta = document.createElement('span');
      meta.className = 'osc-meta';
      meta.textContent = `${role.trim() ? role.trim() + ' · ' : ''}${Math.round(osc.startF)}–${Math.round(osc.endF)} Hz · ${Math.round(osc.startT)}–${Math.round(osc.endT)} ms`;
      item.append(badge, comment, meta);
    });
  }
}
