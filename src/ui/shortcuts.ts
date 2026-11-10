/**
 * Keyboard shortcuts.
 *
 * The original drove its accelerators through a Win32 accelerator table that
 * was not recovered from the binary; the web port uses the conventional set
 * (Ctrl+N/O/S, Ctrl+Z/X/C/V, Ctrl+M, Ctrl+B) and maps them onto the same
 * command ids as the menus.
 */

export interface ShortcutHandlers {
  newSong: () => void;
  open: () => void;
  save: () => void;
  undo: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  mute: () => void;
  addOscillator: () => void;
  play: () => void;
  stop: () => void;
  exportWav: () => void;
}

export function installShortcuts(handlers: ShortcutHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      if (event.key === ' ') {
        event.preventDefault();
        handlers.play();
      }
      return;
    }

    const key = event.key.toLowerCase();
    let action: (() => void) | null = null;

    switch (key) {
      case 'n':
        action = handlers.newSong;
        break;
      case 'o':
        action = handlers.open;
        break;
      case 's':
        action = handlers.save;
        break;
      case 'z':
        action = handlers.undo;
        break;
      case 'x':
        action = handlers.cut;
        break;
      case 'c':
        action = handlers.copy;
        break;
      case 'v':
        action = handlers.paste;
        break;
      case 'm':
        action = handlers.mute;
        break;
      case 'b':
        action = handlers.addOscillator;
        break;
      case 'e':
        action = handlers.exportWav;
        break;
      default:
        action = null;
    }

    if (action) {
      event.preventDefault();
      action();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
