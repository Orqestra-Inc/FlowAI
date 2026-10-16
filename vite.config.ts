import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Unminified with source maps for the hackathon build, so any browser error names the real function.
  build: { outDir: '../dist/web', emptyOutDir: true, minify: false, sourcemap: true, target: 'es2019' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
      '/mcp': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
});
