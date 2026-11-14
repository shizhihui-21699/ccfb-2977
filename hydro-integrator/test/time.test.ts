import { describe, expect, it } from 'vitest';
import {
  assignOccurrences, offsetMsAt, parseWallClock, toIsoUtc, wallToUtc,
} from '../src/util/time.ts';

describe('时区换算：Asia/Shanghai（全年 UTC+8，无 DST）', () => {
  it('常规时刻偏移恒为 +8 小时', () => {
    expect(offsetMsAt('Asia/Shanghai', Date.UTC(2026, 6, 1, 0, 0, 0))).toBe(8 * 3600_000);
    expect(offsetMsAt('Asia/Shanghai', Date.UTC(2026, 0, 15, 12, 0, 0))).toBe(8 * 3600_000);
  });

  it('北京墙钟 2026-07-01 08:00:00 -> UTC 00:00:00', () => {
    const parts = parseWallClock('2026-07-01 08:00:00')!;
    const r = wallToUtc('Asia/Shanghai', parts);
    expect(r.kind).toBe('normal');
    expect(toIsoUtc(r.utcMs)).toBe('2026-07-01T00:00:00Z');
  });

  it('北京午夜 -> 前一天 16:00 UTC', () => {
    const parts = parseWallClock('2026-01-01 00:00:00')!;
    const r = wallToUtc('Asia/Shanghai', parts);
    expect(toIsoUtc(r.utcMs)).toBe('2025-12-31T16:00:00Z');
  });
});

describe('时区换算：America/New_York DST 回退（fold）', () => {
  // 2026-11-01 02:00 本地回退到 01:00，EDT(UTC-4) -> EST(UTC-5)
  const foldWall = parseWallClock('2026-11-01 01:30:00')!;

  it('第一次出现按过渡前 EDT(-4) 解释', () => {
    const r0 = wallToUtc('America/New_York', foldWall, 0);
    expect(r0.kind).toBe('fold');
    expect(toIsoUtc(r0.utcMs)).toBe('2026-11-01T05:30:00Z');
  });

  it('第二次出现按过渡后 EST(-5) 解释，两个 UTC 时刻相差 1 小时', () => {
    const r1 = wallToUtc('America/New_York', foldWall, 1);
    expect(r1.kind).toBe('fold');
    expect(toIsoUtc(r1.utcMs)).toBe('2026-11-01T06:30:00Z');
  });

  it('assignOccurrences 给重复墙钟正确编号', () => {
    const occ = assignOccurrences(['01:00', '01:30', '01:00', '01:30', '02:00']);
    expect(occ).toEqual([0, 0, 1, 1, 0]);
  });
});

describe('时区换算：America/New_York DST 跳时（gap）', () => {
  // 2026-03-08 02:00 -> 03:00，02:30 本地不存在
  const gapWall = parseWallClock('2026-03-08 02:30:00')!;

  it('不存在的墙钟前调到过渡后，返回 gap_adjusted', () => {
    const r = wallToUtc('America/New_York', gapWall);
    expect(r.kind).toBe('gap_adjusted');
    // 过渡后为 EDT(UTC-4)，02:30 前调后的有效瞬间 = 03:30 EDT = 07:30 UTC
    expect(toIsoUtc(r.utcMs)).toBe('2026-03-08T07:30:00Z');
  });

  it('gap 之外的常规时刻不受影响', () => {
    const before = wallToUtc('America/New_York', parseWallClock('2026-03-08 01:30:00')!);
    expect(toIsoUtc(before.utcMs)).toBe('2026-03-08T06:30:00Z');
    const after = wallToUtc('America/New_York', parseWallClock('2026-03-08 03:30:00')!);
    expect(toIsoUtc(after.utcMs)).toBe('2026-03-08T07:30:00Z');
  });
});

describe('parseWallClock 容错', () => {
  it('支持斜杠日期与单位数月日', () => {
    expect(parseWallClock('2026/1/5 9:00:00')).toEqual({
      year: 2026, month: 1, day: 5, hour: 9, minute: 0, second: 0,
    });
  });
  it('非法字符串返回 null', () => {
    expect(parseWallClock('时间无法解析')).toBeNull();
    expect(parseWallClock('')).toBeNull();
  });
});
