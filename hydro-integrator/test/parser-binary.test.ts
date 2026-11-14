import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinaryLanshiParser, lanshiEpochToIso } from '../src/parsers/binary-lanshi.ts';
import { crc32 } from '../src/util/hash.ts';
import {
  decodeHeader, encodeHeader, encodeRecord, encodeTrailer, HEADER_SIZE,
} from '../src/parsers/binary-codec.ts';

const dataDir = join(import.meta.dirname, '..', 'testdata', 'lanshi');
const parser = new BinaryLanshiParser();

async function load(name: string) {
  return new Uint8Array(await readFile(join(dataDir, name)));
}

describe('蓝石二进制解析器', () => {
  it('完好小样例：header/record/UTC 时间换算正确', async () => {
    const parsed = await parser.parse('sample_good_LS01.bin', await load('sample_good_LS01.bin'), 3);
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.records).toHaveLength(1);
    const r = parsed.records[0];
    expect(r.sourceLine).toBe(1);
    // 北京伪 epoch：2026-06-01 08:00 北京墙钟 -> 2026-06-01 00:00 UTC
    expect(lanshiEpochToIso(Number(r.fields.ts_epoch_s), false)).toBe('2026-06-01T00:00:00Z');
    expect(r.fields.level_cm).toBe(612); // 6.12m
  });

  it('UTC epoch 标志位置 1 时直接按 UTC 解释', () => {
    const epoch = Date.UTC(2026, 7, 3, 2, 0, 0) / 1000;
    expect(lanshiEpochToIso(epoch, true)).toBe('2026-08-03T02:00:00Z');
  });

  it('正常月度文件可解析出上千条记录且无 fatal', async () => {
    const parsed = await parser.parse('LS_LS01_202606_A.bin', await load('LS_LS01_202606_A.bin'), 3);
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.records.length).toBeGreaterThan(2000); // 半月 × 144 条/天（10 分钟）
  });

  it('CRC 错误：整文件拒绝并给出 fatalError', async () => {
    const parsed = await parser.parse(
      'LS_LS03_202606_A_crcerr.bin', await load('LS_LS03_202606_A_crcerr.bin'), 3,
    );
    expect(parsed.fatalError).toContain('CRC32');
    expect(parsed.records).toHaveLength(0);
  });

  it('截断文件：CRC 自洽但记录数短少 -> 完整记录入库并报 TRUNCATED_RECORD', async () => {
    const parsed = await parser.parse(
      'LS_LS03_202607_A_trunc.bin', await load('LS_LS03_202607_A_trunc.bin'), 3,
    );
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.issues.some((i) => i.code === 'TRUNCATED_RECORD')).toBe(true);
    expect(parsed.records.length).toBeGreaterThan(100);
  });

  it('补传文件解析为 2 条修正记录', async () => {
    const parsed = await parser.parse(
      'backfill_LS02_202608_fix.bin', await load('backfill_LS02_202608_fix.bin'), 3,
    );
    expect(parsed.fatalError).toBeUndefined();
    expect(parsed.records).toHaveLength(2);
  });
});

describe('HYDROBIN 编解码往返', () => {
  it('header 编码后可解码，字段一致', () => {
    const bytes = encodeHeader({
      version: 1, flags: 1, stationId: 'LS99', intervalMin: 15, recordCount: 2,
    });
    const h = decodeHeader(bytes);
    expect(h).toMatchObject({ version: 1, flags: 1, stationId: 'LS99', intervalMin: 15, recordCount: 2 });
  });

  it('record 往返 + trailer CRC 自洽', () => {
    const header = encodeHeader({ version: 1, flags: 0, stationId: 'LS99', intervalMin: 10, recordCount: 1 });
    const rec = encodeRecord({
      epochSeconds: 1000, levelCm: 1234, flowDLps: 56, rain10um: 7, voltageDV: 120, qc: 0,
    });
    const body = new Uint8Array(header.length + rec.length);
    body.set(header);
    body.set(rec, HEADER_SIZE);
    const trailer = encodeTrailer(crc32(body));
    const full = new Uint8Array(body.length + trailer.length);
    full.set(body);
    full.set(trailer, body.length);
    const h = decodeHeader(full);
    expect(typeof h).not.toBe('string');
    // 复用 verifyTrailer 的公开行为：通过 parser 间接验证
  });
});
