import { defineConfig } from 'vite';

export default defineConfig({
  // The AudioWorklet module is bundled as an ES module so that
  // `audioWorklet.addModule()` can evaluate it directly.
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
