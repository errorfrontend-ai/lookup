import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * In development the portal is served on port 5180 and forwards /api to the API on port 3100, so the
 * browser sees one origin: the session cookies are first-party and the same __Host- cookie settings
 * work in development and production.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false },
    },
  },
  preview: { port: 5180, strictPort: true },
  // Source maps are written for our own debugging but not linked from the bundle, so browsers
  // never download the original source and file paths.
  build: { sourcemap: 'hidden' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup-tests.ts'],
    css: false,
    // The build machine is slow (4 CPUs, little memory); whole-portal tests need more than the 5 s default.
    testTimeout: 15_000,
  },
});
