import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/** Builds the email action page (password reset, verification) for Firebase Hosting. */
export default defineConfig({
  root: fileURLToPath(new URL('./action', import.meta.url)),
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist-action', import.meta.url)),
    emptyOutDir: true,
  },
});
