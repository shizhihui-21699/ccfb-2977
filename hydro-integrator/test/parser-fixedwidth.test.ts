import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedWidthYuanshanParser } from '../src/parsers/fixedwidth-yuanshan.ts';

const dataDir = join(import.meta.dirname, '..', 'testdata', 'yuanshan');
const parser = new FixedWidthYuanshanParser();

async function load(name: string) {
  return new Uint8Array(await readFile(join(dataDir, name)));
}

describe('远山定宽文本解析器', () => {
  it('按字符位置正确切列，UTC 时间原样保留', async () => {
    const parsed = await parser.parse('YS_YS01_202606_A.txt', await load('YS_YS01_202606_A.txt'), 2);
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.records.length).toBeGreaterThan(700); // 半月 × 48 条/天
    const r = parsed.records[0];
    expect(r.fields.station).toBe('YS01');
    expect(r.rawTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(typeof r.fields.level_fixed === 'number' || r.fields.level_fixed === null).toBe(true);
  });

  it('哨兵值 9999.00 / 99.00 / 99 转为 null 缺测', async () => {
    const parsed = await parser.parse('YS_YS01_202606_A.txt', await load('YS_YS01_202606_A.txt'), 2);
    const levels = parsed.records.map((r) => r.fields.level_fixed);
    expect(levels.some((v) => v === null)).toBe(true);
    expect(levels.every((v) => v !== 9999)).toBe(true);
    const qcs = parsed.records.map((r) => r.fields.qc_fixed);
    expect(qcs.some((v) => v === null)).toBe(true);
  });

  it('截断行报 TRUNCATED_RECORD 且其余行继续解析', async () => {
    // 生成器在第 30 数据行拦腰截断（fileIdx=12/24）
    const target = 'YS_YS03_202609_B.txt';
    const parsed = await parser.parse(target, await load(target), 2);
    const trunc = parsed.issues.filter((i) => i.code === 'TRUNCATED_RECORD');
    expect(trunc.length).toBe(1);
    expect(parsed.records.length).toBe(30); // 前 30 行完整，第 31 行被截断
  });

  it('补传文件解析为 2 行', async () => {
    const parsed = await parser.parse(
      'backfill_YS01_202608_fix.txt', await load('backfill_YS01_202608_fix.txt'), 2,
    );
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].fields.level_fixed).toBe(39.1);
  });
});
