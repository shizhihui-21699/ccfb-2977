/**
 * 时间处理：本地墙钟时间 -> UTC，正确处理时区偏移与夏令时。
 *
 * 设计要点：
 * - 不依赖第三方时区库，直接用 Intl.DateTimeFormat 获取 IANA 时区在任意时刻的偏移；
 * - 中国站（Asia/Shanghai）全年 UTC+8 无 DST，走同一套逻辑也完全正确；
 * - 春季跳时（gap）：墙钟时间在本地不存在，向前调整到过渡点之后，并给出告警；
 * - 秋季回退（fold）：同一墙钟时间出现两次，按文件内出现次序（occurrence）消歧，
 *   第一次解释为过渡前（较大偏移），第二次解释为过渡后（较小偏移）。
 *
 * 判定原理：给定一个具体的 UTC 瞬间，Intl 给出的本地偏移是唯一确定的。
 * 因此把墙钟分别用“过渡前大偏移 / 过渡后小偏移”换算成两个 UTC 候选，
 * 再回查每个候选瞬间的真实偏移是否与假设一致，即可严格区分
 * 常规时刻、fold（两个候选都成立）与 gap（两个候选都不成立）。
 */

const cachedFormatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = cachedFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cachedFormatters.set(timeZone, f);
  }
  return f;
}

/** 取某 UTC 毫秒时刻在指定 IANA 时区的偏移（毫秒，东区为正）。 */
export function offsetMsAt(timeZone: string, utcMs: number): number {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs;
}

export interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedResult {
  utcMs: number;
  /** 该墙钟最终采用的偏移（毫秒） */
  offsetMs: number;
  kind: 'normal' | 'gap_adjusted' | 'fold';
}

/**
 * 把本地墙钟时间转成 UTC 毫秒。
 * @param occurrence 同一墙钟在序列中的出现次序（0 起），用于 fold 消歧
 */
export function wallToUtc(timeZone: string, p: WallClockParts, occurrence = 0): ZonedResult {
  const naiveUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

  // 在 ±6h 邻域取过渡两侧的偏移（DST 过渡跨度恒为 1h，6h 足以跨过边界；
  // 无 DST 的时区两个探针返回相同偏移，自然退化为常规路径）
  const offsetBefore = offsetMsAt(timeZone, naiveUtc - 6 * 3600_000);
  const offsetAfter = offsetMsAt(timeZone, naiveUtc + 6 * 3600_000);
  const largeOffset = Math.max(offsetBefore, offsetAfter);
  const smallOffset = Math.min(offsetBefore, offsetAfter);

  const earlierUtc = naiveUtc - largeOffset;
  const laterUtc = naiveUtc - smallOffset;
  const earlierValid = offsetMsAt(timeZone, earlierUtc) === largeOffset;
  const laterValid = offsetMsAt(timeZone, laterUtc) === smallOffset;

  if (earlierValid && laterValid && largeOffset !== smallOffset) {
    // fold：同一墙钟两种解释都成立，按出现次序消歧
    return occurrence > 0
      ? { utcMs: laterUtc, offsetMs: smallOffset, kind: 'fold' }
      : { utcMs: earlierUtc, offsetMs: largeOffset, kind: 'fold' };
  }

  if (earlierValid) {
    return { utcMs: earlierUtc, offsetMs: largeOffset, kind: 'normal' };
  }
  if (laterValid) {
    return { utcMs: laterUtc, offsetMs: smallOffset, kind: 'normal' };
  }

  // gap：墙钟在本地不存在，前调到过渡之后第一个有效瞬间
  return { utcMs: laterUtc, offsetMs: smallOffset, kind: 'gap_adjusted' };
}

/** 把 UTC 毫秒格式化为 ISO 字符串（秒级，带 Z）。 */
export function toIsoUtc(utcMs: number): string {
  return new Date(utcMs).toISOString().replace('.000Z', 'Z');
}

/**
 * 给一个时间序列标注 occurrence：相邻（或全序列中）相同墙钟字符串第几次出现。
 * 典型用途：DST 回退导致的重复时刻，第二次出现应解释为过渡后的本地时间。
 */
export function assignOccurrences(timestamps: string[]): number[] {
  const seen = new Map<string, number>();
  return timestamps.map((t) => {
    const n = seen.get(t) ?? 0;
    seen.set(t, n + 1);
    return n;
  });
}

/** 解析 "YYYY-MM-DD HH:mm:ss" 形式的墙钟时间。 */
export function parseWallClock(s: string): WallClockParts | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}

/** 解析带 Z 或偏移量的 ISO 时间，返回 UTC 毫秒。 */
export function parseIsoToUtcMs(s: string): number | null {
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? null : t;
}
