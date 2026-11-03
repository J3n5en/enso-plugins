import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  // 本地开发时 /v1 走线上 Worker
  server: { proxy: { '/v1': { target: 'https://enso-plugins.j3.do', changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
