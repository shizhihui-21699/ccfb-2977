/**
 * 界面查询服务：把分散在各层的只读查询聚合成页面易用的函数。
 */
import type { DataSource, FieldMapping, QcFlag } from '../types.ts';
import { sql, withConn } from './connection.ts';
import { ensureSchema } from './import-service.ts';
import { listDataSources, listMappings, listStations, listBatches } from './metadata.ts';
import { listFlags } from '../qc/engine.ts';
import { traceDwdPoint } from '../lineage/lineage-service.ts';

export interface DwdRow {
  stationCode: string;
  tsUtc: string;
  waterLevelM: number | null;
  flowM3s: number | null;
  rainfallMm: number | null;
  voltageV: number | null;
  qualityCode: number | null;
  sourceFileName: string;
  sourceLine: number;
  flags: string[];
}

/** 分页/筛选浏览 DWD 宽表，并带上该行的质控标记。 */
export async function browseDwd(options: {
  station?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<{ rows: DwdRow[]; total: number }> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.station) { where.push('station_code = ?'); params.push(options.station); }
    if (options.from) { where.push("ts_utc >= CAST(? AS TIMESTAMP WITH TIME ZONE)"); params.push(options.from); }
    if (options.to) { where.push("ts_utc <= CAST(? AS TIMESTAMP WITH TIME ZONE)"); params.push(options.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = options.limit ?? 200;

    const total = Number(
      (await sql(conn, `SELECT count(*)::INTEGER n FROM dwd_water_record ${clause}`, params)).toArray()[0].n,
    );
    const r = await sql(conn,
      `SELECT * FROM dwd_water_record ${clause} ORDER BY ts_utc DESC, station_code LIMIT ?`,
      [...params, limit],
    );
    const flags = await listFlags(undefined, 5000);
    const flagByKey = new Map<string, string[]>();
    for (const f of flags) {
      const key = `${f.stationCode}|${f.tsUtc}`;
      const arr = flagByKey.get(key) ?? [];
      arr.push(f.flagType);
      flagByKey.set(key, arr);
    }

    const rows: DwdRow[] = r.toArray().map((row) => {
      const tsUtc = new Date(Number(row.ts_utc)).toISOString();
      return {
        stationCode: String(row.station_code),
        tsUtc,
        waterLevelM: row.water_level_m === null ? null : Number(row.water_level_m),
        flowM3s: row.flow_m3s === null ? null : Number(row.flow_m3s),
        rainfallMm: row.rainfall_mm === null ? null : Number(row.rainfall_mm),
        voltageV: row.voltage_v === null ? null : Number(row.voltage_v),
        qualityCode: row.quality_code === null ? null : Number(row.quality_code),
        sourceFileName: String(row.source_file_name),
        sourceLine: Number(row.source_line),
        flags: flagByKey.get(`${String(row.station_code)}|${tsUtc}`) ?? [],
      };
    });
    return { rows, total };
  });
}

export interface BatchDetail {
  batchNo: string;
  importedAt: string;
  status: string;
  recordCount: number;
  duplicateFileCount: number;
  duplicateRowCount: number;
  supersededCount: number;
  issueCount: number;
  files: {
    fileName: string;
    status: string;
    recordCount: number;
    fatalError: string | null;
  }[];
}

export async function getBatchDetail(batchId: number): Promise<BatchDetail | null> {
  return withConn(async (conn) => {
    const b = await sql(conn, 'SELECT * FROM import_batch WHERE id = ?', [batchId]);
    if (b.numRows === 0) return null;
    const batch = b.toArray()[0];
    const f = await sql(conn,
      'SELECT file_name, status, record_count, fatal_error FROM batch_file WHERE batch_id = ? ORDER BY id',
      [batchId],
    );
    return {
      batchNo: String(batch.batch_no),
      importedAt: new Date(Number(batch.imported_at)).toISOString(),
      status: String(batch.status),
      recordCount: Number(batch.record_count),
      duplicateFileCount: Number(batch.duplicate_file_count),
      duplicateRowCount: Number(batch.duplicate_row_count),
      supersededCount: Number(batch.superseded_count),
      issueCount: Number(batch.issue_count),
      files: f.toArray().map((x) => ({
        fileName: String(x.file_name),
        status: String(x.status),
        recordCount: Number(x.record_count),
        fatalError: x.fatal_error ? String(x.fatal_error) : null,
      })),
    };
  });
}

export async function listBatchIds(): Promise<{ id: number; batchNo: string }[]> {
  return withConn(async (conn) => {
    const r = await sql(conn, 'SELECT id, batch_no FROM import_batch ORDER BY id DESC');
    return r.toArray().map((x) => ({ id: Number(x.id), batchNo: String(x.batch_no) }));
  });
}

/** 取某条质控标记对应 DWD 点的完整血缘（供质控页下钻）。 */
export async function flagLineage(flag: QcFlag) {
  return traceDwdPoint(flag.stationCode, flag.tsUtc);
}

export type { DataSource, FieldMapping };
export { listDataSources, listMappings, listStations, listBatches };
