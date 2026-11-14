import { defineConfig } from 'vite';

// duckdb-wasm 的 mvp 构建不需要 COOP/COEP 跨域隔离头，这里保留配置入口；
// 若将来切换到 eh/pthreads 构建，需打开下面的 headers。
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    // headers: {
    //   'Cross-Origin-Opener-Policy': 'same-origin',
    //   'Cross-Origin-Embedder-Policy': 'require-corp',
    // },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
