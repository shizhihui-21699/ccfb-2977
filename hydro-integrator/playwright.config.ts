/**
 * 真实浏览器冒烟测试：验证 duckdb-wasm 在浏览器 worker 中能实例化，
 * 五个页面可渲染、种子数据就位、可导入文件并算出指标。
 * 需先启动 vite dev server（webServer 配置会自动拉起）。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
