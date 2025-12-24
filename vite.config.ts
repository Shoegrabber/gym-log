import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: './src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    minify: false,
  },
});
