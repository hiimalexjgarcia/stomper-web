import './styles.css';
import { App } from './app.ts';

declare global {
  interface Window {
    /** Handy for debugging and for the browser smoke test. */
    stomper?: App;
  }
}

const root = document.getElementById('app');
if (root) {
  const app = new App();
  window.stomper = app;
  app.mount(root);
}
