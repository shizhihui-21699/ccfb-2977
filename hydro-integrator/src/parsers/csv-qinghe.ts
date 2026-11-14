/**
 * 清河仪器 CSV 解析器。
 *
 * 文件样例（UTF-8，首行中文表头，时间为北京时间墙钟）：
 *   时间,站码,水位(m),流量(m3/s),降雨量(mm),电压(V),质量码
 *   2026-08-01 00:00:00,QH01,12.34,3.21,0.0,12.1,0
 *
 * 容错策略：
 * - 列数与表头不一致 -> 该行记 TRUNCATED_RECORD 错误并跳过，不中断整文件；
 * - 空字段 -> null（缺测），数字解析失败 -> BAD_NUMBER 且该字段置 null；
 * - 时间解析失败 -> BAD_TIMESTAMP，整行跳过（没有可信时间戳的行不能入 DWD）。
 */
import type { ParsedFile, ParseIssue, RawRecord } from '../types.ts';
import { sha256File } from '../util/hash.ts';
import { assignOccurrences, parseWallClock } from '../util/time.ts';
import { splitCsvLine, stripBom, type FileParser } from './types.ts';

export const QINGHE_SOURCE_FIELDS = [
  '时间',
  '站码',
  '水位(m)',
  '流量(m3/s)',
  '降雨量(mm)',
  '电压(V)',
  '质量码',
] as const;

export class CsvQingheParser implements FileParser {
  readonly format = 'csv_qinghe' as const;

  async parse(fileName: string, bytes: Uint8Array, dataSourceId: number): Promise<ParsedFile> {
    const t0 = performance.now();
    const fileHash = await sha256File(bytes);
    const text = stripBom(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    const lines = text.split(/\r?\n/);
    const issues: ParseIssue[] = [];
    const records: RawRecord[] = [];

    const headerLine = lines.find((l) => l.trim().length > 0);
    if (!headerLine) {
      return {
        fileName, dataSourceId, format: this.format, fileHash, records, issues,
        fatalError: '空文件：未找到表头行', parseMs: performance.now() - t0,
      };
    }
    const header = splitCsvLine(headerLine).map((h) => h.trim());
    const headerIdx = lines.indexOf(headerLine);

    const dataLines = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0);
    const rawTimestamps = dataLines.map((l) => splitCsvLine(l)[0] ?? '');
    const occurrences = assignOccurrences(rawTimestamps);

    dataLines.forEach((line, i) => {
      const sourceLine = headerIdx + 2 + i;
      const cells = splitCsvLine(line);
      if (cells.length !== header.length) {
        issues.push({
          sourceLine, level: 'error', code: 'TRUNCATED_RECORD',
          message: `列数 ${cells.length} 与表头 ${header.length} 不一致，该行已跳过`,
        });
        return;
      }
      const row = header.map((h, j) => [h, cells[j].trim()] as const);
      const rawTs = row.find(([h]) => h === '时间')?.[1] ?? '';
      if (!parseWallClock(rawTs)) {
        issues.push({
          sourceLine, level: 'error', code: 'BAD_TIMESTAMP',
          message: `无法解析的时间戳: "${rawTs}"`,
        });
        return;
      }

      const fields: Record<string, string | number | null> = {};
      for (const [h, v] of row) {
        if (h === '时间' || h === '站码') {
          fields[h] = v === '' ? null : v;
          continue;
        }
        if (v === '') {
          fields[h] = null;
          continue;
        }
        const n = Number(v);
        if (Number.isNaN(n)) {
          issues.push({
            sourceLine, level: 'warn', code: 'BAD_NUMBER',
            message: `字段 "${h}" 的值 "${v}" 不是数字，按缺测处理`,
          });
          fields[h] = null;
        } else {
          fields[h] = n;
        }
      }

      records.push({ sourceLine, fields, rawTimestamp: rawTs, occurrence: occurrences[i] });
    });

    return {
      fileName, dataSourceId, format: this.format, fileHash, records, issues,
      parseMs: performance.now() - t0,
    };
  }
}
