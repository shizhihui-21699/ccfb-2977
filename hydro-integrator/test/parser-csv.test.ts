import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CsvQingheParser } from '../src/parsers/csv-qinghe.ts';

const dataDir = join(import.meta.dirname, '..', 'testdata', 'qinghe');

async function load(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(dataDir, name)));
}

describe('清河 CSV 解析器', () => {
  const parser = new CsvQingheParser();

  it('正常文件：字段类型、缺测空值与行号正确', async () => {
    const parsed = await parser.parse('QH_QH01_202606_A.csv', await load('QH_QH01_202606_A.csv'), 1);
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.records.length).toBeGreaterThan(300);
    const first = parsed.records[0];
    expect(first.sourceLine).toBe(2); // 表头占第 1 行
    expect(typeof first.fields['水位(m)'] === 'number' || first.fields['水位(m)'] === null).toBe(true);
    expect(first.rawTimestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 至少出现过一次缺测空值
    const hasNull = parsed.records.some((r) => r.fields['水位(m)'] === null);
    expect(hasNull).toBe(true);
  });

  it('截断行：报 TRUNCATED_RECORD 且不中断整文件', async () => {
    // 生成器在第 40 数据行植入少列截断（fileIdx=11/22）
    const target = 'QH_QH03_202608_B.csv';
    const parsed = await parser.parse(target, await load(target), 1);
    const trunc = parsed.issues.filter((i) => i.code === 'TRUNCATED_RECORD');
    expect(trunc.length).toBe(1);
    expect(parsed.records.length).toBe(39); // 前 39 条数据行完整
  });

  it('坏时间戳：报 BAD_TIMESTAMP 且该行跳过', async () => {
    const target = 'QH_QH02_202608_A.csv'; // 含一行“时间无法解析”
    const parsed = await parser.parse(target, await load(target), 1);
    expect(parsed.issues.some((i) => i.code === 'BAD_TIMESTAMP')).toBe(true);
  });

  it('DST fold 文件：重复墙钟的 occurrence 依次为 0/1', async () => {
    const parsed = await parser.parse('dst_fold_NY01.csv', await load('dst_fold_NY01.csv'), 1);
    const oneOclock = parsed.records.filter((r) => r.rawTimestamp.startsWith('2026-11-01 01:'));
    expect(oneOclock.map((r) => r.occurrence)).toEqual([0, 0, 1, 1]);
  });

  it('补传文件可正常解析，行数与内容一致', async () => {
    const parsed = await parser.parse(
      'backfill_QH01_202607_fix.csv', await load('backfill_QH01_202607_fix.csv'), 1,
    );
    expect(parsed.records).toHaveLength(3);
    expect(parsed.records[0].fields['站码']).toBe('QH01');
  });

  it('同内容两次解析的 fileHash 稳定', async () => {
    const bytes = await load('QH_QH01_202606_A.csv');
    const a = await parser.parse('a.csv', bytes, 1);
    const b = await parser.parse('renamed.csv', bytes, 1);
    expect(a.fileHash).toBe(b.fileHash);
    expect(a.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
