/**
 * 元数据仓储：数据源、字段映射、站点配置、批次查询。
 * 种子数据对应三个厂家与 8 个示范水文站。
 */
import type { DataSource, FieldMapping, ImportBatch } from '../types.ts';
import { defaultMappings } from '../mapping/canonical.ts';
import { sql, withConn } from './connection.ts';
import { ensureSchema } from './import-service.ts';

const SEED_SOURCES: Omit<DataSource, 'id' | 'createdAt'>[] = [
  {
    vendor: '清河仪器', format: 'csv_qinghe', tzMode: 'Asia/Shanghai',
    description: 'CSV 文本，中文表头，北京时间墙钟', enabled: true,
  },
  {
    vendor: '远山测控', format: 'fixedwidth_yuanshan', tzMode: 'UTC',
    description: '定宽文本，无表头，UTC 时间，缺测带哨兵值', enabled: true,
  },
  {
    vendor: '蓝石电子', format: 'binary_lanshi', tzMode: 'Asia/Shanghai',
    description: 'HYDROBIN 二进制，CRC32 校验，时间语义见文件 flags', enabled: true,
  },
];

const SEED_STATIONS = [
  ['QH01', '清河闸站', 18.5, 60],
  ['QH02', '清河上游站', 22.0, 60],
  ['QH03', '清河分水口站', 19.0, 60],
  ['YS01', '云山水库站', 45.0, 30],
  ['YS02', '云山溢洪道站', 40.5, 30],
  ['YS03', '云山干渠站', 38.0, 30],
  ['LS01', '兰石河口站', 8.0, 10],
  ['LS02', '兰石闸坝站', 12.5, 10],
  ['LS03', '兰石支流站', 15.0, 15],
  ['LS04', '兰石交汇站', 10.0, 15],
] as const;

export async function seedMetadata(): Promise<void> {
  await withConn(async (conn) => {
    await ensureSchema(conn);
    const count = await sql(conn, 'SELECT count(*)::INTEGER AS n FROM data_source');
    if (Number(count.toArray()[0].n) > 0) return;

    for (let i = 0; i < SEED_SOURCES.length; i++) {
      const s = SEED_SOURCES[i];
      const id = i + 1;
      await sql(conn, 
        `INSERT INTO data_source (id, vendor, format, tz_mode, manual_tz, description, enabled)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        [id, s.vendor, s.format, s.tzMode, s.description, s.enabled],
      );
      for (const m of defaultMappings(id, s.format)) {
        await sql(conn, 
          `INSERT INTO field_mapping (id, data_source_id, source_field, target_field, scale, "offset", builtin)
           VALUES (nextval('seq_field_mapping'), ?, ?, ?, ?, ?, ?)`,
          [id, m.sourceField, m.targetField, m.scale, m.offset, m.builtin],
        );
      }
    }

    for (const [code, name, warn, interval] of SEED_STATIONS) {
      await sql(conn, 
        `INSERT INTO station_config (station_code, station_name, warning_level_m, expected_interval_min)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [code, name, warn, interval],
      );
    }
  });
}

export async function listDataSources(): Promise<DataSource[]> {
  return withConn(async (conn) => {
    const r = await sql(conn, 'SELECT * FROM data_source ORDER BY id');
    return r.toArray().map((row) => ({
      id: Number(row.id),
      vendor: String(row.vendor),
      format: String(row.format) as DataSource['format'],
      tzMode: String(row.tz_mode) as DataSource['tzMode'],
      manualTz: row.manual_tz ? String(row.manual_tz) : undefined,
      description: String(row.description ?? ''),
      enabled: Boolean(row.enabled),
      createdAt: new Date(row.created_at as number).toISOString(),
    }));
  });
}

export async function listMappings(dataSourceId?: number): Promise<FieldMapping[]> {
  return withConn(async (conn) => {
    const r = dataSourceId
      ? await sql(conn, 'SELECT * FROM field_mapping WHERE data_source_id = ? ORDER BY id', [dataSourceId])
      : await sql(conn, 'SELECT * FROM field_mapping ORDER BY data_source_id, id');
    return r.toArray().map((row) => ({
      id: Number(row.id),
      dataSourceId: Number(row.data_source_id),
      sourceField: String(row.source_field),
      targetField: (row.target_field ?? null) as FieldMapping['targetField'],
      scale: Number(row.scale),
      offset: Number(row.offset),
      builtin: Boolean(row.builtin),
    }));
  });
}

export async function updateMapping(m: FieldMapping): Promise<void> {
  await withConn(async (conn) => {
    await sql(conn, 
      `UPDATE field_mapping SET source_field = ?, target_field = ?, scale = ?, "offset" = ?
       WHERE id = ?`,
      [m.sourceField, m.targetField, m.scale, m.offset, m.id],
    );
  });
}

export async function listStations(): Promise<Record<string, unknown>[]> {
  return withConn(async (conn) => {
    const r = await sql(conn, 'SELECT * FROM station_config ORDER BY station_code');
    return r.toArray().map((row) => ({
      stationCode: String(row.station_code),
      stationName: String(row.station_name),
      warningLevelM: Number(row.warning_level_m),
      expectedIntervalMin: Number(row.expected_interval_min),
      active: Boolean(row.active),
    }));
  });
}

export async function listBatches(): Promise<ImportBatch[]> {
  return withConn(async (conn) => {
    const r = await sql(conn, 'SELECT * FROM import_batch ORDER BY id DESC');
    return r.toArray().map((row) => ({
      id: Number(row.id),
      batchNo: String(row.batch_no),
      importedAt: new Date(row.imported_at as number).toISOString(),
      fileCount: Number(row.file_count),
      recordCount: Number(row.record_count),
      duplicateFileCount: Number(row.duplicate_file_count),
      duplicateRowCount: Number(row.duplicate_row_count),
      supersededCount: Number(row.superseded_count),
      issueCount: Number(row.issue_count),
      status: String(row.status) as ImportBatch['status'],
      note: String(row.note ?? ''),
    }));
  });
}
