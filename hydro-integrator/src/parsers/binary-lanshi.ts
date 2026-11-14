/**
 * 蓝石电子 二进制 HYDROBIN 解析器。
 *
 * 与另外两个文本解析器的差异：
 * - 溯源行号 sourceLine 取记录序号（从 1 开始），文件头不占行号；
 * - 文件尾 CRC32 不匹配（含被截断导致的长度不符）-> 整条文件拒绝（fatalError），
 *   因为无法确认已有记录是否完整、是否被篡改，宁可拒收也不让脏数据进 ODS；
 * - 若 CRC 通过但实际可读记录少于 header 声明数 -> 完整记录照常入库，
 *   截断点出一条 TRUNCATED_RECORD error issue；
 * - flags 决定 epoch 语义：UTC 直接用；北京时间“伪 epoch”需先还原墙钟再按时区换算。
 */
import type { ParsedFile, ParseIssue, RawRecord } from '../types.ts';
import { sha256File } from '../util/hash.ts';
import { toIsoUtc, wallToUtc, type WallClockParts } from '../util/time.ts';
import {
  decodeHeader, decodeRecord, FLAG_UTC_EPOCH, HEADER_SIZE, RECORD_SIZE,
  SENTINEL_LEVEL, SENTINEL_U8, SENTINEL_USHORT, verifyTrailer,
} from './binary-codec.ts';
import type { FileParser } from './types.ts';

export const LANSHI_SOURCE_FIELDS = [
  'station_id',
  'ts_epoch_s',
  'level_cm',
  'flow_dLps',
  'rain_10um',
  'voltage_dV',
  'qc_byte',
] as const;

export class BinaryLanshiParser implements FileParser {
  readonly format = 'binary_lanshi' as const;

  async parse(fileName: string, bytes: Uint8Array, dataSourceId: number): Promise<ParsedFile> {
    const t0 = performance.now();
    const fileHash = await sha256File(bytes);
    const issues: ParseIssue[] = [];
    const records: RawRecord[] = [];

    const headerOrErr = decodeHeader(bytes);
    if (typeof headerOrErr === 'string') {
      return {
        fileName, dataSourceId, format: this.format, fileHash, records, issues,
        fatalError: headerOrErr, parseMs: performance.now() - t0,
      };
    }
    const header = headerOrErr;

    const trailer = verifyTrailer(bytes, header);
    if (trailer.error) {
      return {
        fileName, dataSourceId, format: this.format, fileHash, records, issues,
        fatalError: trailer.error, parseMs: performance.now() - t0,
      };
    }
    if (trailer.truncated) {
      issues.push({
        sourceLine: trailer.actualRecordCount + 1,
        level: 'error',
        code: 'TRUNCATED_RECORD',
        message: `记录区截断：header 声明 ${header.recordCount} 条，实际完整可读 ${trailer.actualRecordCount} 条`,
      });
    }

    const isUtc = (header.flags & FLAG_UTC_EPOCH) !== 0;
    // 同一墙钟的出现次序，用于 DST fold 消歧（蓝石若部署在海外有 DST 地区）
    const seenWall = new Map<string, number>();

    for (let i = 0; i < trailer.actualRecordCount; i++) {
      const off = HEADER_SIZE + i * RECORD_SIZE;
      const sourceLine = i + 1;
      const r = decodeRecord(bytes, off);

      let rawTimestamp: string;
      let occurrence = 0;
      if (isUtc) {
        rawTimestamp = `${r.epochSeconds}s@UTC`;
      } else {
        // 伪 epoch：数值本身是“把北京墙钟当 UTC”得到的秒数
        const fakeDate = new Date(r.epochSeconds * 1000);
        rawTimestamp = `${fakeDate.getUTCFullYear()}-${pad(fakeDate.getUTCMonth() + 1)}-${pad(fakeDate.getUTCDate())} ` +
          `${pad(fakeDate.getUTCHours())}:${pad(fakeDate.getUTCMinutes())}:${pad(fakeDate.getUTCSeconds())}@BJT`;
        occurrence = seenWall.get(rawTimestamp) ?? 0;
        seenWall.set(rawTimestamp, occurrence + 1);
      }

      const fields: Record<string, string | number | null> = {
        // 站码存于文件头，下沉到每条记录，供字段映射取 station_code
        station_id: header.stationId,
        ts_epoch_s: r.epochSeconds,
        level_cm: r.levelCm === SENTINEL_LEVEL ? null : r.levelCm,
        flow_dLps: r.flowDLps === SENTINEL_USHORT ? null : r.flowDLps,
        rain_10um: r.rain10um === SENTINEL_USHORT ? null : r.rain10um,
        voltage_dV: r.voltageDV === SENTINEL_U8 ? null : r.voltageDV,
        qc_byte: r.qc === SENTINEL_U8 ? null : r.qc,
      };

      if (!isUtc) {
        const parts = parseFakeEpoch(r.epochSeconds);
        const zoned = wallToUtc('Asia/Shanghai', parts, occurrence);
        if (zoned.kind === 'gap_adjusted') {
          issues.push({
            sourceLine, level: 'warn', code: 'DST_GAP_ADJUSTED',
            message: '时间落在夏令时跳时间隙，已前调至过渡后时刻',
          });
        } else if (zoned.kind === 'fold') {
          issues.push({
            sourceLine, level: 'warn', code: 'DST_FOLD',
            message: `夏令时回退重复时刻，第 ${occurrence + 1} 次出现，按次序消歧`,
          });
        }
      }

      records.push({ sourceLine, fields, rawTimestamp, occurrence });
    }

    return {
      fileName, dataSourceId, format: this.format, fileHash, records, issues,
      parseMs: performance.now() - t0,
    };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 把“伪 UTC epoch 秒”还原成墙钟部件（getUTC* 系列，因为 epoch 是假装按 UTC 计的）。 */
function parseFakeEpoch(epochSeconds: number): WallClockParts {
  const d = new Date(epochSeconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** 供映射/测试模块复用：把一条蓝石记录的 epoch 转成 UTC ISO（含 BJT 伪 epoch 语义）。 */
export function lanshiEpochToIso(epochSeconds: number, isUtc: boolean, occurrence = 0): string {
  if (isUtc) return toIsoUtc(epochSeconds * 1000);
  const d = new Date(epochSeconds * 1000);
  const parts: WallClockParts = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
  return toIsoUtc(wallToUtc('Asia/Shanghai', parts, occurrence).utcMs);
}
