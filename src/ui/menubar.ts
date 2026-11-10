/**
 * Menu bar.
 *
 * The original used the Win32 menu resource 131 (File / Edit / Special / Web /
 * Help) and drove every entry through a command id in the message map.  The web
 * port keeps the ids so the command table stays comparable with the analysis.
 */

export interface MenuEntry {
  /** command id from the original message map, e.g. 0xE100 */
  id?: number;
  label: string;
  accel?: string;
  run?: () => void;
  checked?: () => boolean;
  disabled?: () => boolean;
  submenu?: MenuEntry[];
}

export interface Menu {
  label: string;
  entries: MenuEntry[];
}

export function createMenubar(container: HTMLElement, menus: Menu[]): void {
  container.innerHTML = '';
  container.className = 'menubar';

  for (const menu of menus) {
    const wrapper = document.createElement('div');
    wrapper.className = 'menu';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-title';
    button.textContent = menu.label;
    wrapper.appendChild(button);

    const list = document.createElement('div');
    list.className = 'menu-list';
    wrapper.appendChild(list);
    container.appendChild(wrapper);

    const build = (entries: MenuEntry[], target: HTMLElement) => {
      target.innerHTML = '';
      for (const entry of entries) {
        if (entry.submenu) {
          const item = document.createElement('div');
          item.className = 'menu-item has-submenu';
          const label = document.createElement('span');
          label.textContent = entry.label;
          const arrow = document.createElement('span');
          arrow.className = 'menu-arrow';
          arrow.textContent = '▸';
          item.append(label, arrow);
          const sub = document.createElement('div');
          sub.className = 'menu-list submenu';
          item.appendChild(sub);
          build(entry.submenu, sub);
          target.appendChild(item);
          continue;
        }

        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'menu-item';
        if (entry.id !== undefined) item.dataset.command = String(entry.id);

        const label = document.createElement('span');
        label.className = 'menu-label';
        label.textContent = entry.label;
        item.appendChild(label);

        if (entry.accel) {
          const accel = document.createElement('span');
          accel.className = 'menu-accel';
          accel.textContent = entry.accel;
          item.appendChild(accel);
        }

        if (entry.checked?.()) item.classList.add('checked');
        if (entry.disabled?.()) {
          item.disabled = true;
          item.classList.add('disabled');
        }

        item.addEventListener('click', () => {
          entry.run?.();
          closeAll();
        });
        target.appendChild(item);
      }
    };

    build(menu.entries, list);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = wrapper.classList.contains('open');
      closeAll();
      if (!wasOpen) wrapper.classList.add('open');
    });
  }

  const closeAll = () => {
    for (const el of container.querySelectorAll('.menu.open')) el.classList.remove('open');
  };

  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll();
  });
}

/** A context menu with the same look and feel as the menu bar. */
export function showContextMenu(anchor: { x: number; y: number }, entries: MenuEntry[]): void {
  document.querySelector('.context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'menu-list context-menu';
  menu.style.left = `${anchor.x}px`;
  menu.style.top = `${anchor.y}px`;

  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = entry.label;
    item.appendChild(label);
    if (entry.checked?.()) item.classList.add('checked');
    if (entry.disabled?.()) item.disabled = true;
    item.addEventListener('click', () => {
      entry.run?.();
      menu.remove();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('click', dismiss);
  };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}
