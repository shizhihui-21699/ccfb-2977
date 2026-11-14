/**
 * 远山测控 定宽文本解析器。
 *
 * 无表头，每行列位置固定（字符偏移，单位为字符，等宽 ASCII）：
 *   0..8   站码（左对齐补空格）
 *   9..28  UTC 时间 YYYY-MM-DDTHH:mm:ssZ（20 字符）
 *   29..37 水位 %9.2f
 *   38..46 流量 %9.2f
 *   47..55 降雨量 %9.2f
 *   56..62 电压 %7.2f
 *   63..65 质量码 %3d
 * 行定长 66 字符 + 换行。缺测哨兵 9999.00（电压哨兵 99.00，质量码 99）。
 *
 * 因为是定宽格式，不能按空白 split（补位空格会破坏列对齐），必须按位置切片。
 * 截断行（长度不足）记 TRUNCATED_RECORD 并跳过。
 */
import type { ParsedFile, ParseIssue, RawRecord } from '../types.ts';
import { sha256File } from '../util/hash.ts';
import { parseIsoToUtcMs } from '../util/time.ts';
import { stripBom, type FileParser } from './types.ts';

const COL = {
  station: [0, 9],
  ts: [9, 29],
  level: [29, 38],
  flow: [38, 47],
  rain: [47, 56],
  voltage: [56, 63],
  qc: [63, 66],
} as const;

export const YUANSHAN_SOURCE_FIELDS = [
  'station',
  'timestamp_utc',
  'level_fixed',
  'flow_fixed',
  'rain_fixed',
  'voltage_fixed',
  'qc_fixed',
] as const;

const MISSING_FLOAT_SENTINEL = 9999.0;
const MISSING_VOLTAGE_SENTINEL = 99.0;
const MISSING_QC_SENTINEL = 99;

function slice(line: string, col: readonly [number, number]): string {
  return line.slice(col[0], col[1]).trim();
}

export class FixedWidthYuanshanParser implements FileParser {
  readonly format = 'fixedwidth_yuanshan' as const;

  async parse(fileName: string, bytes: Uint8Array, dataSourceId: number): Promise<ParsedFile> {
    const t0 = performance.now();
    const fileHash = await sha256File(bytes);
    const text = stripBom(new TextDecoder('utf-8').decode(bytes));
    const lines = text.split(/\r?\n/);
    const issues: ParseIssue[] = [];
    const records: RawRecord[] = [];

    lines.forEach((rawLine, idx) => {
      const line = rawLine;
      if (line.trim().length === 0) return;
      const sourceLine = idx + 1;

      // 时间列必须完整；其余定宽列只要有任一缺失即视为行级截断
      if (line.length < COL.ts[1]) {
        issues.push({
          sourceLine, level: 'error', code: 'TRUNCATED_RECORD',
          message: `定宽行长度 ${line.length} 不足，时间列至少需要 ${COL.ts[1]} 字符，该行已跳过`,
        });
        return;
      }
      if (line.length < COL.qc[1]) {
        issues.push({
          sourceLine, level: 'error', code: 'TRUNCATED_RECORD',
          message: `定宽行长度 ${line.length} 不足 ${COL.qc[1]} 字符，存在列被截断，该行已跳过`,
        });
        return;
      }

      const station = slice(line, COL.station);
      const rawTs = slice(line, COL.ts);
      if (parseIsoToUtcMs(rawTs) === null) {
        issues.push({
          sourceLine, level: 'error', code: 'BAD_TIMESTAMP',
          message: `无法解析的 UTC 时间戳: "${rawTs}"`,
        });
        return;
      }

      const numField = (col: readonly [number, number], sentinel: number, label: string): number | null => {
        if (line.length < col[1]) {
          // 行级截断已在入口统一报过一次，这里静默按缺测处理，避免同一行刷多条 issue
          return null;
        }
        const v = slice(line, col);
        if (v === '') return null;
        const n = Number(v);
        if (Number.isNaN(n)) {
          issues.push({
            sourceLine, level: 'warn', code: 'BAD_NUMBER',
            message: `字段 ${label} 的值 "${v}" 不是数字，按缺测处理`,
          });
          return null;
        }
        return Math.abs(n - sentinel) < 1e-9 ? null : n;
      };

      const qcRaw = line.length >= COL.qc[1] ? slice(line, COL.qc) : '';
      const qcNum = qcRaw === '' ? null : Number(qcRaw);
      const qc = qcNum === null || Number.isNaN(qcNum) || qcNum === MISSING_QC_SENTINEL ? null : qcNum;

      records.push({
        sourceLine,
        rawTimestamp: rawTs,
        occurrence: 0, // UTC 时间不存在 DST 重复时刻
        fields: {
          station,
          timestamp_utc: rawTs,
          level_fixed: numField(COL.level, MISSING_FLOAT_SENTINEL, 'level'),
          flow_fixed: numField(COL.flow, MISSING_FLOAT_SENTINEL, 'flow'),
          rain_fixed: numField(COL.rain, MISSING_FLOAT_SENTINEL, 'rain'),
          voltage_fixed: numField(COL.voltage, MISSING_VOLTAGE_SENTINEL, 'voltage'),
          qc_fixed: qc,
        },
      });
    });

    return {
      fileName, dataSourceId, format: this.format, fileHash, records, issues,
      parseMs: performance.now() - t0,
    };
  }
}
