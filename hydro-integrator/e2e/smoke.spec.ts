import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dataRoot = join(import.meta.dirname, '..', 'testdata');

test('浏览器端全链路：初始化 → 导入 → 质控 → 指标 → 血缘', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');
  // DuckDB-WASM 实例化 + 种子写入需要几秒
  await expect(page.locator('h1')).toHaveText('数据源与字段映射', { timeout: 30000 });

  // 数据源页：三个厂家卡片
  await expect(page.locator('.card', { hasText: '清河仪器' })).toBeVisible();
  await expect(page.locator('.card', { hasText: '远山测控' })).toBeVisible();
  await expect(page.locator('.card', { hasText: '蓝石电子' })).toBeVisible();
  // 蓝石厘米->米换算系数（level_cm 行的 scale 输入框值为 0.01）
  const lanshiCard = page.locator('.card', { hasText: '蓝石电子' });
  const levelRow = lanshiCard.locator('tr', { hasText: 'level_cm' });
  await expect(levelRow.locator('input[type=number]').first()).toHaveValue('0.01');
  // 下拉框已正确选中 water_level_m
  await expect(levelRow.locator('select')).toHaveValue('water_level_m');

  // 切到导入页；二进制文件需先选蓝石数据源，CSV 选清河
  await page.getByRole('button', { name: '导入批次' }).click();
  await expect(page.locator('h1')).toHaveText('导入批次');

  // 先导入清河 CSV（默认数据源即清河）
  const fileInput = page.locator('.page-actions input[type=file][multiple]');
  await fileInput.setInputFiles([join(dataRoot, 'qinghe', 'QH_QH01_202606_A.csv')]);
  await expect(page.locator('#batch-list tbody tr')).toHaveCount(1, { timeout: 30000 });

  // 切到蓝石数据源，导入正常样本 + CRC 坏文件
  await page.locator('.card select').first().selectOption({ index: 2 });
  await fileInput.setInputFiles([
    join(dataRoot, 'lanshi', 'sample_good_LS01.bin'),
    join(dataRoot, 'lanshi', 'LS_LS03_202606_A_crcerr.bin'),
  ]);
  await expect(page.locator('#batch-list tbody tr')).toHaveCount(2, { timeout: 30000 });
  // 第二个批次的明细里 CRC 坏文件应是 rejected
  await page.getByRole('button', { name: '明细' }).first().click();
  await expect(page.locator('.modal')).toContainText('CRC32');
  await page.locator('.modal-mask').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.modal')).toHaveCount(0);

  // 质控页：重跑自动规则
  await page.getByRole('button', { name: '质控' }).click();
  await page.getByRole('button', { name: '重跑自动质控' }).click();
  await expect(page.locator('#flag-list')).toContainText(/跳变|缺测|超量程|长时间不变/, { timeout: 30000 });

  // 指标页：重算并看到日指标
  await page.getByRole('button', { name: '指标' }).click();
  await page.getByRole('button', { name: '重算指标' }).click();
  await expect(page.locator('#daily table tbody tr')).not.toHaveCount(0, { timeout: 30000 });

  // 血缘页：能看到 DWD 行并打开追溯弹窗
  await page.getByRole('button', { name: '数据血缘' }).click();
  await expect(page.locator('#dwd-list table tbody tr')).not.toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '追溯' }).first().click();
  await expect(page.locator('.modal')).toContainText('ODS');
  await expect(page.locator('.modal')).toContainText('原始字段');

  // 不应有未捕获的前端错误（duckdb 内部的低级别 warning 不算）
  const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  expect(fatal).toEqual([]);
});
