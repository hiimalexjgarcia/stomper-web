/**
 * Oscillator tab strip — the web version of FUN_00404A40.
 *
 * The original filled a CTabCtrl with one tab per oscillator (caption = the
 * index, plus the filter name when the slot is a filter) and a final "New"
 * tab; the tab image encoded the state (Off / On / Inaudible).
 */

import type { AppState } from '../model/store.ts';
import { ROLE_NAMES } from '../model/types.ts';

export function createTabs(
  container: HTMLElement,
  onSelect: (index: number) => void,
  onNew: () => void,
): { update: (state: AppState) => void } {
  container.innerHTML = '';
  container.className = 'tabs';

  const update = (state: AppState) => {
    const wanted = state.song.oscillators.length + 1;
    while (container.children.length > wanted) container.lastElementChild?.remove();
    while (container.children.length < wanted) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.addEventListener('click', () => {
        const index = Number(tab.dataset.index ?? '-1');
        if (index < 0) onNew();
        else onSelect(index);
      });
      container.appendChild(tab);
    }

    state.song.oscillators.forEach((osc, index) => {
      const tab = container.children[index] as HTMLButtonElement;
      tab.dataset.index = String(index);
      const isFilter = osc.role !== 0;
      const caption = isFilter ? `${index} ${ROLE_NAMES[osc.role]}` : String(index);
      const stateClass = osc.enabled === 0 ? 'off' : osc.enabled === 2 ? 'inaudible' : 'on';
      tab.className = `tab ${stateClass}${state.tab === index ? ' selected' : ''}`;
      tab.title = `Oscillator ${index} — ${osc.comment || 'no comment'}`;
      tab.innerHTML = '';
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      const text = document.createElement('span');
      text.textContent = caption;
      tab.append(dot, text);
    });

    const newTab = container.children[state.song.oscillators.length] as HTMLButtonElement;
    newTab.dataset.index = '-1';
    newTab.className = 'tab new';
    newTab.innerHTML = '';
    newTab.textContent = 'New';
    newTab.title = 'Add an oscillator';
  };

  return { update };
}
