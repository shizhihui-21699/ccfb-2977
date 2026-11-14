/**
 * 字段映射与宽表规范化。
 *
 * 职责：把三个厂家各自的原始字段（RawRecord.fields）按可配置的 FieldMapping
 * 统一映射到 CanonicalField 宽表字段，数值做线性换算 (v + offset) * scale，
 * 时间统一转 UTC ISO 字符串。
 *
 * 时间字段不走 scale/offset，而由数据源的时区配置驱动：
 * - csv_qinghe：北京时间墙钟 -> UTC（Asia/Shanghai，无 DST）
 * - fixedwidth_yuanshan：ISO UTC 直接解析
 * - binary_lanshi：按 header flags 区分 UTC epoch 与北京伪 epoch
 */
import type {
  CanonicalField, DataSource, FieldMapping, ParsedFile, ParseIssue,
} from '../types.ts';
import { recordHash } from '../util/hash.ts';
import {
  lanshiEpochToIso,
} from '../parsers/binary-lanshi.ts';
import {
  parseIsoToUtcMs, parseWallClock, toIsoUtc, wallToUtc,
} from '../util/time.ts';

export interface CanonicalRow {
  stationCode: string;
  tsUtc: string;
  waterLevelM: number | null;
  flowM3s: number | null;
  rainfallMm: number | null;
  voltageV: number | null;
  qualityCode: number | null;
  /** 溯源键 */
  fileHash: string;
  fileName: string;
  sourceLine: number;
  recordHash: string;
  /** 原始时间戳，原样保留供血缘展示 */
  rawTimestamp: string;
}

export function defaultMappings(dataSourceId: number, format: DataSource['format']): FieldMapping[] {
  const mk = (
    sourceField: string, targetField: CanonicalField | null,
    scale = 1, offset = 0, builtin = true,
  ): FieldMapping => ({
    id: 0, dataSourceId, sourceField, targetField, scale, offset, builtin,
  });

  if (format === 'csv_qinghe') {
    return [
      mk('时间', 'ts_utc'),
      mk('站码', 'station_code'),
      mk('水位(m)', 'water_level_m'),
      mk('流量(m3/s)', 'flow_m3s'),
      mk('降雨量(mm)', 'rainfall_mm'),
      mk('电压(V)', 'voltage_v'),
      mk('质量码', 'quality_code'),
    ];
  }
  if (format === 'fixedwidth_yuanshan') {
    return [
      mk('timestamp_utc', 'ts_utc'),
      mk('station', 'station_code'),
      mk('level_fixed', 'water_level_m'),
      mk('flow_fixed', 'flow_m3s'),
      mk('rain_fixed', 'rainfall_mm'),
      mk('voltage_fixed', 'voltage_v'),
      mk('qc_fixed', 'quality_code'),
    ];
  }
  return [
    mk('ts_epoch_s', 'ts_utc'),
    mk('station_id', 'station_code'),
    mk('level_cm', 'water_level_m', 0.01),
    mk('flow_dLps', 'flow_m3s', 0.1),
    mk('rain_10um', 'rainfall_mm', 0.0001),
    mk('voltage_dV', 'voltage_v', 0.1),
    mk('qc_byte', 'quality_code'),
  ];
}

function applyScale(v: number | null, m: FieldMapping): number | null {
  if (v === null || v === undefined) return null;
  return (v + m.offset) * m.scale;
}

function resolveTimeZone(ds: DataSource): string {
  if (ds.tzMode === 'UTC') return 'UTC';
  if (ds.tzMode === 'Asia/Shanghai') return 'Asia/Shanghai';
  return ds.manualTz || 'UTC';
}

/**
 * 把一个已解析文件规范化为宽表行。
 * 无法确定时间或站码的行会被跳过，并补一条 issue。
 */
export async function canonicalize(
  parsed: ParsedFile,
  ds: DataSource,
  mappings: FieldMapping[],
): Promise<{ rows: CanonicalRow[]; extraIssues: ParseIssue[] }> {
  const active = mappings.filter((m) => m.targetField !== null);
  const byField = new Map(active.map((m) => [m.sourceField, m]));
  const extraIssues: ParseIssue[] = [];
  const rows: CanonicalRow[] = [];
  const tz = resolveTimeZone(ds);

  for (const rec of parsed.records) {
    const get = (target: CanonicalField): FieldMapping | undefined =>
      active.find((m) => m.targetField === target);

    // ---- 时间 ----
    let tsUtc: string | null = null;
    const tsMap = get('ts_utc');
    if (tsMap) {
      const raw = rec.fields[tsMap.sourceField];
      if (parsed.format === 'binary_lanshi') {
        const isUtc = (ds.tzMode === 'UTC');
        tsUtc = lanshiEpochToIso(Number(raw), isUtc, rec.occurrence);
      } else if (parsed.format === 'fixedwidth_yuanshan') {
        const ms = parseIsoToUtcMs(String(raw));
        if (ms !== null) tsUtc = toIsoUtc(ms);
      } else {
        const parts = parseWallClock(String(raw));
        if (parts) {
          const zoned = wallToUtc(tz, parts, rec.occurrence);
          tsUtc = toIsoUtc(zoned.utcMs);
          if (zoned.kind === 'gap_adjusted') {
            extraIssues.push({
              sourceLine: rec.sourceLine, level: 'warn', code: 'DST_GAP_ADJUSTED',
              message: '时间落在夏令时跳时间隙，已前调至过渡后时刻',
            });
          } else if (zoned.kind === 'fold') {
            extraIssues.push({
              sourceLine: rec.sourceLine, level: 'warn', code: 'DST_FOLD',
              message: `夏令时回退重复时刻，第 ${rec.occurrence + 1} 次出现，按次序消歧`,
            });
          }
        }
      }
    }

    // ---- 站码 ----
    const stMap = get('station_code');
    let stationCode: string | null = null;
    if (stMap) {
      const v = rec.fields[stMap.sourceField];
      if (v !== null && v !== undefined && String(v).trim() !== '') stationCode = String(v).trim();
    }
    if (!stationCode) {
      extraIssues.push({
        sourceLine: rec.sourceLine, level: 'error', code: 'UNKNOWN_STATION',
        message: '缺少站码，该行无法入宽表',
      });
      continue;
    }
    if (!tsUtc) {
      extraIssues.push({
        sourceLine: rec.sourceLine, level: 'error', code: 'BAD_TIMESTAMP',
        message: `时间字段无法转 UTC，原始值: "${rec.rawTimestamp}"`,
      });
      continue;
    }

    const numOrNull = (target: CanonicalField): number | null => {
      const m = byField.get(active.find((x) => x.targetField === target)?.sourceField ?? '');
      if (!m) return null;
      const v = rec.fields[m.sourceField];
      if (v === null || v === undefined || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isNaN(n)) return null;
      return applyScale(n, m);
    };

    const canonicalKey = [
      stationCode, tsUtc,
      rec.fields[get('water_level_m')?.sourceField ?? ''] ?? '',
      rec.fields[get('flow_m3s')?.sourceField ?? ''] ?? '',
      rec.fields[get('rainfall_mm')?.sourceField ?? ''] ?? '',
      rec.fields[get('voltage_v')?.sourceField ?? ''] ?? '',
      rec.fields[get('quality_code')?.sourceField ?? ''] ?? '',
    ].join('|');

    rows.push({
      stationCode,
      tsUtc,
      waterLevelM: numOrNull('water_level_m'),
      flowM3s: numOrNull('flow_m3s'),
      rainfallMm: numOrNull('rainfall_mm'),
      voltageV: numOrNull('voltage_v'),
      qualityCode: numOrNull('quality_code'),
      fileHash: parsed.fileHash,
      fileName: parsed.fileName,
      sourceLine: rec.sourceLine,
      recordHash: await recordHash(parsed.fileHash, rec.sourceLine, canonicalKey),
      rawTimestamp: rec.rawTimestamp,
    });
  }

  return { rows, extraIssues };
}
