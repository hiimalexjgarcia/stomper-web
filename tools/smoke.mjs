#!/usr/bin/env node
/**
 * Browser smoke test.
 *
 * Drives the built application in headless Chrome through the DevTools
 * protocol: it checks that the user interface is built, that oscillators can
 * be added, that playback and the offline WAV export work and that no error
 * reaches the console.
 *
 * Usage:
 *   npm run build
 *   npx vite preview --port 4173 &
 *   node tools/smoke.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:4173/';
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'stomper-smoke-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

const cleanup = () => {
  chrome.kill('SIGKILL');
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevTools() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

class Session {
  #ws;
  #id = 0;
  #pending = new Map();
  consoleErrors = [];
  exceptions = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
        else pending?.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.exceptions.push(details.exception?.description ?? details.text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 30000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

const failures = [];
const check = (name, ok, detail = '') => {
  const status = ok ? 'ok  ' : 'FAIL';
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function main() {
  await waitForDevTools();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const session = new Session(ws);

  await session.send('Runtime.enable');
  await session.send('Page.enable');
  await session.send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(2500);
  console.log('-- page loaded, running checks --');

  // --- the user interface is built -----------------------------------------
  const dom = await session.eval(`
    return {
      menu: !!document.querySelector('#menubar .menu-title'),
      tabs: document.querySelectorAll('#tabs .tab').length,
      list: document.querySelectorAll('#osclist .osc-item').length,
      params: document.querySelectorAll('#params .field').length,
      canvas: !!document.querySelector('#editor'),
      transport: !!document.querySelector('#transport #play'),
      status: document.querySelector('#status')?.textContent ?? '',
      title: document.title,
    };
  `);
  check('menu bar is built', dom.menu);
  check('oscillator tab exists', dom.tabs >= 2, `${dom.tabs} tabs`);
  check('oscillator list is filled', dom.list === 1, `${dom.list} items`);
  check('parameter panel is filled', dom.params > 5, `${dom.params} fields`);
  check('editor canvas exists', dom.canvas);
  check('transport exists', dom.transport);
  check('status bar shows the song length', dom.status.includes('Length'), dom.status.slice(0, 80));

  // --- adding an oscillator ------------------------------------------------
  const added = await session.eval(`
    document.querySelectorAll('#tabs .tab')[1].click();
    await new Promise((r) => setTimeout(r, 200));
    const app = window.stomper;
    return {
      oscillators: app ? app['store'].state.song.oscillators.length : -1,
      listItems: document.querySelectorAll('#osclist .osc-item').length,
    };
  `);
  check('a new oscillator is added', added.oscillators === 2, `${added.oscillators} oscillators`);
  check('the list follows the model', added.listItems === 2, `${added.listItems} items`);

  // --- the context menu (RT_MENU 152) ---------------------------------------
  const menu = await session.eval(`
    const item = document.querySelectorAll('#osclist .osc-item')[1];
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
    await new Promise((r) => setTimeout(r, 150));
    const entries = Array.from(document.querySelectorAll('.context-menu .menu-item .menu-label')).map((n) => n.textContent);
    return { entries, open: !!document.querySelector('.context-menu') };
  `);
  check('the context menu opens', menu.open);
  check('the context menu carries the original entries', menu.entries.includes('Inaudible') && menu.entries.includes('Insert After'), menu.entries.join(', '));

  const inaudible = await session.eval(`
    const labels = Array.from(document.querySelectorAll('.context-menu .menu-item'));
    const target = labels.find((n) => n.textContent.includes('Inaudible'));
    target.click();
    await new Promise((r) => setTimeout(r, 150));
    const app = window.stomper;
    return app['store'].state.song.oscillators[1].enabled;
  `);
  check('"Inaudible" sets the slot state', inaudible === 2, `enabled=${inaudible}`);

  // --- undo ---------------------------------------------------------------
  const undone = await session.eval(`
    const app = window.stomper;
    app['undo']();
    await new Promise((r) => setTimeout(r, 150));
    return app['store'].state.song.oscillators[1].enabled;
  `);
  check('undo restores the previous state', undone === 1, `enabled=${undone}`);

  // --- the demo song -------------------------------------------------------
  const demo = await session.eval(`
    const app = window.stomper;
    app['loadDemo']();
    await new Promise((r) => setTimeout(r, 200));
    return {
      oscillators: app['store'].state.song.oscillators.length,
      status: document.querySelector('#status').textContent,
    };
  `);
  check('the built-in demo loads', demo.oscillators === 6, `${demo.oscillators} oscillators`);

  // --- playback ------------------------------------------------------------
  const playback = await session.eval(`
    const app = window.stomper;
    await app['togglePlay']();
    await new Promise((r) => setTimeout(r, 400));
    const running = app['playback'].running;
    const status = document.querySelector('#status').textContent;
    await app['stopPlayback']();
    await new Promise((r) => setTimeout(r, 200));
    return { running, status, stopped: !app['playback'].running };
  `);
  check('playback starts', playback.running === true, playback.status.slice(0, 60));
  check('playback stops', playback.stopped === true);

  // --- natural end flips the transport back to Play ------------------------
  const naturalEnd = await session.eval(`
    const app = window.stomper;
    const source = app['store'].state.song.oscillators[0];
    const short = { ...source, startT: 0, endT: 60, enabled: 1, role: 0, noiseBW: 0 };
    app['store'].state.song.oscillators = [short];
    app['store'].touch('song');
    await app['togglePlay']();
    await new Promise((r) => setTimeout(r, 700));
    const result = {
      playing: app['store'].state.playing,
      running: app['playback'].running,
      label: document.querySelector('#play').textContent,
    };
    app['loadDemo']();
    await new Promise((r) => setTimeout(r, 100));
    return result;
  `);
  check(
    'the transport returns to Play at the natural end',
    naturalEnd.playing === false && naturalEnd.running === false && naturalEnd.label.includes('Play'),
    `playing=${naturalEnd.playing} running=${naturalEnd.running} label=${naturalEnd.label}`,
  );

  // --- offline export ------------------------------------------------------
  const exported = await session.eval(`
    const app = window.stomper;
    app['store'].state.song.rate = 22050;
    const result = await app['exportWav']();
    await new Promise((r) => setTimeout(r, 500));
    return { status: document.querySelector('#status').textContent };
  `);
  check('the WAV export renders the song', /Exported .*\.wav/.test(exported.status), exported.status.slice(-90));

  // --- display modes -------------------------------------------------------
  const modes = await session.eval(`
    const app = window.stomper;
    app['setFreqDisplay']('note');
    app['setTimeDisplay']('beat');
    await new Promise((r) => setTimeout(r, 150));
    const status = document.querySelector('#status').textContent;
    app['setFreqDisplay']('hz');
    app['setTimeDisplay']('ms');
    return { status };
  `);
  check('the display modes are applied', modes.status.includes('Note') && modes.status.includes('beat:fraction'), modes.status.slice(0, 120));

  // --- saving --------------------------------------------------------------
  const saved = await session.eval(`
    const app = window.stomper;
    app['store'].state.song.filename = 'smoke.stu';
    await app['save'](false);
    await new Promise((r) => setTimeout(r, 300));
    return { status: document.querySelector('#status').textContent, dirty: app['store'].state.song.dirty };
  `);
  check('the song is saved', saved.status.includes('Saved'), saved.status.slice(-60));
  check('the dirty flag is cleared', saved.dirty === false);

  // --- loading a .STU back --------------------------------------------------
  const loaded = await session.eval(`
    const app = window.stomper;
    const before = app['store'].state.song.oscillators.length;
    const ini = app.toIni();
    await app['loadFile'](ini, 'roundtrip.stu');
    await new Promise((r) => setTimeout(r, 200));
    const after = app['store'].state.song.oscillators.length;
    return { before, after, ini: ini.slice(0, 40) };
  `);
  check('a .STU file round trips', loaded.before === loaded.after, `${loaded.before} -> ${loaded.after}`);

  // --- console health -------------------------------------------------------
  check('no uncaught exceptions', session.exceptions.length === 0, session.exceptions.join(' | '));
  check('no console errors', session.consoleErrors.length === 0, session.consoleErrors.join(' | '));

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  } else {
    console.log('all checks passed');
  }
  ws.close();
  cleanup();
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
