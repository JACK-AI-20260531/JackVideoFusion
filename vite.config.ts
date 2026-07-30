import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { builtinModules } from 'module';

// Vite 配置:同时服务渲染层与构建 Electron 主进程
export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
      external: ['electron', ...builtinModules.flatMap((m) => [m, `node:${m}`])],
    },
  },
});
