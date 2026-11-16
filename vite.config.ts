import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5317, strictPort: true },
  preview: { port: 5317, strictPort: true },
});
