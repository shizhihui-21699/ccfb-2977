/**
 * 数据血缘服务。
 *
 * 血缘链路（点任意一个数即可逐级下钻）：
 *   DWS 指标（日/月聚合）
 *     -> 当天/当月的 DWD 宽表行
 *       -> dwd_record_lineage 登记的 ODS 原始记录（含被补传覆盖的历史来源）
 *         -> 原始文件名 + 文件内行号 + 原始字段 JSON + 原始时间戳
 *
 * ODS 只追加、不更新、不删除，因此哪怕 DWD 的当前值已被补传覆盖，
 * 旧值“当时来自哪个文件的哪一行”仍然可以完整还原。
 */
import type { LineageEdge } from '../types.ts';
import { sql, withConn } from '../db/connection.ts';
import { ensureSchema } from '../db/import-service.ts';

export interface LineageResult {
  edges: LineageEdge[];
  /** ODS 原始字段明细，key = fileName:line */
  rawDetails: Record<string, Record<string, unknown>>;
}

/** 从 DWD 宽表的一个点（站 + UTC 时刻）向下溯源。 */
export async function traceDwdPoint(stationCode: string, tsUtc: string): Promise<LineageResult> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    const edges: LineageEdge[] = [];
    const rawDetails: Record<string, Record<string, unknown>> = {};

    const dwd = await sql(conn, 
      `SELECT * FROM dwd_water_record WHERE station_code = ? AND ts_utc = ?`,
      [stationCode, tsUtc],
    );
    if (dwd.numRows === 0) return { edges, rawDetails };
    const d = dwd.toArray()[0];
    edges.push({
      layer: 'DWD', tableName: 'dwd_water_record', stationCode,
      tsUtc: new Date(Number(d.ts_utc)).toISOString(),
      fileName: String(d.source_file_name), sourceLine: Number(d.source_line),
      detail: `宽表当前值：水位=${fmt(d.water_level_m)}m 流量=${fmt(d.flow_m3s)}m³/s ` +
        `降雨=${fmt(d.rainfall_mm)}mm 电压=${fmt(d.voltage_v)}V`,
    });

    const lineage = await sql(conn, 
      `SELECT * FROM dwd_record_lineage
       WHERE station_code = ? AND ts_utc = ?
       ORDER BY is_current DESC, valid_from`,
      [stationCode, tsUtc],
    );

    for (const l of lineage.toArray()) {
      const fileName = String(l.file_name);
      const sourceLine = Number(l.source_line);
      const ods = await sql(conn, 
        `SELECT source_line, file_name, raw_timestamp, raw_fields, record_hash, ingested_at
         FROM ods_raw_record WHERE record_hash = ?`,
        [String(l.ods_record_hash)],
      );
      const isCurrent = Boolean(l.is_current);
      if (ods.numRows > 0) {
        const o = ods.toArray()[0];
        const key = `${fileName}:${sourceLine}`;
        rawDetails[key] = {
          rawTimestamp: String(o.raw_timestamp),
          rawFields: typeof o.raw_fields === 'string' ? JSON.parse(o.raw_fields) : o.raw_fields,
          recordHash: String(o.record_hash),
          ingestedAt: new Date(Number(o.ingested_at)).toISOString(),
        };
        edges.push({
          layer: 'ODS', tableName: 'ods_raw_record', stationCode,
          tsUtc: new Date(Number(l.ts_utc)).toISOString(),
          fileName, sourceLine,
          detail: `${isCurrent ? '当前来源' : '已被补传覆盖的历史来源'}：${fileName} 第 ${sourceLine} 行` +
            `（原始时间戳 ${String(o.raw_timestamp)}）`,
        });
      }
    }

    return { edges, rawDetails };
  });
}

/** 从 DWS 日指标下钻：返回当天该站所有 DWD 点的溯源入口。 */
export async function traceDailyMetric(stationCode: string, statDate: string): Promise<LineageResult> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    const edges: LineageEdge[] = [];
    const dws = await sql(conn, 
      'SELECT * FROM dws_daily WHERE station_code = ? AND stat_date = ?',
      [stationCode, statDate],
    );
    if (dws.numRows > 0) {
      const a = dws.toArray()[0];
      edges.push({
        layer: 'DWS', tableName: 'dws_daily', stationCode, tsUtc: `${statDate}T00:00:00Z`,
        fileName: '', sourceLine: null,
        detail: `日指标：日均=${fmt(a.avg_level_m)}m 最高=${fmt(a.max_level_m)}m ` +
          `最低=${fmt(a.min_level_m)}m 超警戒=${Number(a.over_warning_minutes)}分钟`,
      });
    }
    const points = await sql(conn, 
      `SELECT ts_utc, source_file_name, source_line, water_level_m
       FROM dwd_water_record
       WHERE station_code = ? AND CAST(ts_utc AT TIME ZONE 'UTC' AS DATE) = ?
       ORDER BY ts_utc LIMIT 500`,
      [stationCode, statDate],
    );
    for (const p of points.toArray()) {
      edges.push({
        layer: 'DWD', tableName: 'dwd_water_record', stationCode,
        tsUtc: new Date(Number(p.ts_utc)).toISOString(),
        fileName: String(p.source_file_name), sourceLine: Number(p.source_line),
        detail: `明细采样：水位=${fmt(p.water_level_m)}m（点击可继续追 ODS 原始行）`,
      });
    }
    return { edges, rawDetails: {} };
  });
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '缺测';
  return Number(v).toFixed(2);
}
