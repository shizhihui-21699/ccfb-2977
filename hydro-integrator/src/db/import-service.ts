/**
 * 导入流水线：解析 -> 规范化 -> ODS 追加 -> DWD 幂等 UPSERT -> 血缘登记。
 *
 * 幂等的三道防线：
 * 1. 文件级：batch_file.file_hash 唯一语义，同一文件再传直接 duplicate_skipped，
 *    不会产生任何 ODS 行；
 * 2. 记录级：ods_raw_record.record_hash 唯一索引，即使文件改名后重传，
 *    内容相同的行也会被拒绝（INSERT OR IGNORE），统计为 duplicate_row；
 * 3. 宽表级：dwd_water_record 按 (station_code, ts_utc) UPSERT，
 *    补传的旧数据（同站同时刻、内容不同）走覆盖更新，旧来源在血缘表标记 superseded，
 *    不会多出数据，也不会丢掉“这个数曾经来自哪个文件”的链路。
 */
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  BatchFile, DataSource, FieldMapping, ImportBatch, ParsedFile, ParseIssue,
} from '../types.ts';
import { canonicalize, type CanonicalRow } from '../mapping/canonical.ts';
import { CsvQingheParser } from '../parsers/csv-qinghe.ts';
import { BinaryLanshiParser } from '../parsers/binary-lanshi.ts';
import { FixedWidthYuanshanParser } from '../parsers/fixedwidth-yuanshan.ts';
import type { FileParser } from '../parsers/types.ts';
import { getDb, loadTempTable, sql, withConn } from './connection.ts';
import { SCHEMA_SQL } from './schema.ts';

export interface ImportInput {
  fileName: string;
  bytes: Uint8Array;
  dataSourceId: number;
}

export interface ImportOutcome {
  batch: ImportBatch;
  files: BatchFile[];
  issues: (ParseIssue & { fileName: string })[];
}

const PARSERS: Record<DataSource['format'], FileParser> = {
  csv_qinghe: new CsvQingheParser(),
  fixedwidth_yuanshan: new FixedWidthYuanshanParser(),
  binary_lanshi: new BinaryLanshiParser(),
};

let schemaReady = false;

export async function ensureSchema(conn: AsyncDuckDBConnection): Promise<void> {
  if (schemaReady) return;
  await conn.query(SCHEMA_SQL);
  schemaReady = true;
}

/** 测试专用：进程内重置 schema 就绪标记。 */
export function resetSchemaFlag(): void {
  schemaReady = false;
}

interface FileResult {
  parsed: ParsedFile;
  rows: CanonicalRow[];
  status: BatchFile['status'];
  fatalError: string | null;
  insertedOds: number;
  duplicateRows: number;
  superseded: number;
}

export async function importFiles(
  inputs: ImportInput[],
  dataSources: DataSource[],
  mappingsByDs: Map<number, FieldMapping[]>,
  note = '',
): Promise<ImportOutcome> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    const dsById = new Map(dataSources.map((d) => [d.id, d]));
    const results: FileResult[] = [];
    const allIssues: (ParseIssue & { fileName: string })[] = [];

    // ---- 阶段 1：解析 + 规范化（纯 CPU，不碰数据库，失败隔离到单文件）----
    for (const input of inputs) {
      const ds = dsById.get(input.dataSourceId);
      if (!ds) throw new Error(`未知数据源 id=${input.dataSourceId}`);
      const parser = PARSERS[ds.format];
      const parsed = await parser.parse(input.fileName, input.bytes, ds.id);
      parsed.issues.forEach((i) => allIssues.push({ ...i, fileName: input.fileName }));

      if (parsed.fatalError) {
        results.push({
          parsed, rows: [], status: 'rejected', fatalError: parsed.fatalError,
          insertedOds: 0, duplicateRows: 0, superseded: 0,
        });
        continue;
      }

      const { rows, extraIssues } = await canonicalize(parsed, ds, mappingsByDs.get(ds.id) ?? []);
      extraIssues.forEach((i) => allIssues.push({ ...i, fileName: input.fileName }));
      results.push({
        parsed, rows, status: 'imported', fatalError: null,
        insertedOds: 0, duplicateRows: 0, superseded: 0,
      });
    }

    // ---- 阶段 2：文件级去重 + 集合化批量写入（每文件一次临时表加载，根治逐行 OOM）----
    const db = await getDb();
    const batchNo = `B${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${inputs.length}f`;
    await conn.query('BEGIN TRANSACTION');
    try {
      const batchIdRow = await sql(conn,
        `INSERT INTO import_batch (batch_no, file_count, record_count, status, note)
         VALUES (?, ?, 0, 'completed', ?) RETURNING id`,
        [batchNo, inputs.length, note],
      );
      const batchId = Number(batchIdRow.toArray()[0].id);

      let totalRecords = 0;
      let dupFiles = 0;
      let dupRows = 0;
      let supersededTotal = 0;

      for (const r of results) {
        const known = await sql(conn,
          'SELECT 1 FROM batch_file WHERE file_hash = ? LIMIT 1',
          [r.parsed.fileHash],
        );
        const isDupFile = known.numRows > 0;
        if (isDupFile && r.status !== 'rejected') {
          r.status = 'duplicate_skipped';
          dupFiles++;
        }

        let insertedOds = 0;
        let superseded = 0;

        if (r.status === 'imported' && r.rows.length > 0) {
          // 1) 本文件所有规范化行进临时表（一次 JSON 批量加载）
          const stage = 'stage_import';
          const stageCols = [
            'station_code', 'ts_utc', 'water_level_m', 'flow_m3s', 'rainfall_mm',
            'voltage_v', 'quality_code', 'record_hash', 'file_hash', 'file_name',
            'source_line', 'raw_timestamp', 'raw_fields',
          ];
          await loadTempTable(
            conn, db, stage,
            // 临时表全 VARCHAR：Arrow 只负责可靠送达，数值/时间在下面的 SQL 里 CAST
            `CREATE TEMP TABLE ${stage} (
               station_code VARCHAR, ts_utc VARCHAR,
               water_level_m VARCHAR, flow_m3s VARCHAR, rainfall_mm VARCHAR, voltage_v VARCHAR,
               quality_code VARCHAR, record_hash VARCHAR, file_hash VARCHAR,
               file_name VARCHAR, source_line VARCHAR, raw_timestamp VARCHAR,
               raw_fields VARCHAR
             )`,
            stageCols,
            {
              station_code: r.rows.map((x) => x.stationCode),
              ts_utc: r.rows.map((x) => x.tsUtc),
              water_level_m: r.rows.map((x) => x.waterLevelM),
              flow_m3s: r.rows.map((x) => x.flowM3s),
              rainfall_mm: r.rows.map((x) => x.rainfallMm),
              voltage_v: r.rows.map((x) => x.voltageV),
              quality_code: r.rows.map((x) => x.qualityCode),
              record_hash: r.rows.map((x) => x.recordHash),
              file_hash: r.rows.map((x) => x.fileHash),
              file_name: r.rows.map((x) => x.fileName),
              source_line: r.rows.map((x) => x.sourceLine),
              raw_timestamp: r.rows.map((x) => x.rawTimestamp),
              raw_fields: r.rows.map((x) =>
                JSON.stringify(r.parsed.records.find((z) => z.sourceLine === x.sourceLine)?.fields ?? {})),
            },
          );

          // 2) ODS 追加：record_hash 冲突即跳过（DuckDB 不支持 INSERT 嵌套子查询，
          //    故先写入、再用 anti-join 回查实际新插入的 hash 填 stage_new）
          await conn.query('CREATE TEMP TABLE stage_new (record_hash VARCHAR)');
          await conn.query(`
            INSERT INTO ods_raw_record
              (id, batch_id, file_name, file_hash, data_source_id, source_line,
               raw_timestamp, raw_fields, record_hash)
            SELECT nextval('seq_ods'), ${batchId}, file_name, file_hash,
                   ${r.parsed.dataSourceId},
                   CAST(source_line AS INTEGER), raw_timestamp,
                   CAST(raw_fields AS JSON), record_hash
            FROM ${stage}
            ON CONFLICT (record_hash) DO NOTHING
          `);
          // stage_new = 本文件中已存在于 ODS 的 hash（即真正新插入的那些）
          await conn.query(`
            INSERT INTO stage_new(record_hash)
            SELECT s.record_hash FROM ${stage} s
            JOIN ods_raw_record o ON o.record_hash = s.record_hash
          `);
          const newCount = Number(
            (await conn.query('SELECT count(*)::INTEGER c FROM stage_new')).toArray()[0].c,
          );
          insertedOds = newCount;
          dupRows += r.rows.length - newCount;

          // 3) 补传覆盖统计：新行中 (站,时刻) 已存在于 DWD 且 hash 不同的数量
          const sup = await conn.query(`
            SELECT count(*)::INTEGER c FROM ${stage} n
            JOIN stage_new sn ON sn.record_hash = n.record_hash
            JOIN dwd_water_record d
              ON d.station_code = n.station_code AND d.ts_utc = CAST(n.ts_utc AS TIMESTAMP WITH TIME ZONE)
            WHERE d.record_hash <> n.record_hash
          `);
          superseded = Number(sup.toArray()[0].c);
          supersededTotal += superseded;

          // 4) 被覆盖点的旧血缘置失效
          await conn.query(`
            UPDATE dwd_record_lineage l SET is_current = false, superseded_at = now()
            WHERE l.is_current = true AND EXISTS (
              SELECT 1 FROM ${stage} n
              JOIN stage_new sn ON sn.record_hash = n.record_hash
              JOIN dwd_water_record d
                ON d.station_code = n.station_code
               AND d.ts_utc = CAST(n.ts_utc AS TIMESTAMP WITH TIME ZONE)
              WHERE n.station_code = l.station_code
                AND CAST(n.ts_utc AS TIMESTAMP WITH TIME ZONE) = l.ts_utc
                AND d.record_hash <> n.record_hash
            )
          `);

          // 5) DWD 幂等 UPSERT（集合化，按 站+时刻）；空字符串转 NULL
          await conn.query(`
            INSERT INTO dwd_water_record
              (id, station_code, ts_utc, water_level_m, flow_m3s, rainfall_mm, voltage_v,
               quality_code, record_hash, source_file_hash, source_file_name, source_line, raw_timestamp)
            SELECT nextval('seq_dwd'), n.station_code,
                   CAST(n.ts_utc AS TIMESTAMP WITH TIME ZONE),
                   NULLIF(n.water_level_m,'')::DOUBLE, NULLIF(n.flow_m3s,'')::DOUBLE,
                   NULLIF(n.rainfall_mm,'')::DOUBLE, NULLIF(n.voltage_v,'')::DOUBLE,
                   NULLIF(n.quality_code,'')::INTEGER,
                   n.record_hash, n.file_hash, n.file_name,
                   CAST(n.source_line AS INTEGER), n.raw_timestamp
            FROM ${stage} n JOIN stage_new sn ON sn.record_hash = n.record_hash
            ON CONFLICT (station_code, ts_utc) DO UPDATE SET
              water_level_m = excluded.water_level_m,
              flow_m3s = excluded.flow_m3s,
              rainfall_mm = excluded.rainfall_mm,
              voltage_v = excluded.voltage_v,
              quality_code = excluded.quality_code,
              record_hash = excluded.record_hash,
              source_file_hash = excluded.source_file_hash,
              source_file_name = excluded.source_file_name,
              source_line = excluded.source_line,
              raw_timestamp = excluded.raw_timestamp,
              updated_at = now()
          `);

          // 6) 血缘登记（同 hash 已存在则保持 current，不重复插）
          await conn.query(`
            INSERT INTO dwd_record_lineage
              (station_code, ts_utc, ods_record_hash, file_name, source_line)
            SELECT n.station_code, CAST(n.ts_utc AS TIMESTAMP WITH TIME ZONE),
                   n.record_hash, n.file_name, n.source_line
            FROM ${stage} n JOIN stage_new sn ON sn.record_hash = n.record_hash
            ON CONFLICT (station_code, ts_utc, ods_record_hash) DO NOTHING
          `);

          await conn.query('DROP TABLE stage_new');
          await conn.query(`DROP TABLE ${stage}`);
        }

        r.insertedOds = insertedOds;
        r.superseded = superseded;
        totalRecords += insertedOds;

        await sql(conn,
          `INSERT INTO batch_file (id, batch_id, file_name, file_hash, data_source_id,
             record_count, status, fatal_error)
           VALUES (nextval('seq_batch_file'), ?, ?, ?, ?, ?, ?, ?)`,
          [
            batchId, r.parsed.fileName, r.parsed.fileHash, r.parsed.dataSourceId,
            insertedOds, r.status, r.fatalError,
          ],
        );
      }

      const anyRejected = results.some((r) => r.status === 'rejected');
      await sql(conn,
        `UPDATE import_batch SET record_count = ?, duplicate_file_count = ?,
           duplicate_row_count = ?, superseded_count = ?, issue_count = ?,
           status = ? WHERE id = ?`,
        [
          totalRecords, dupFiles, dupRows, supersededTotal, allIssues.length,
          anyRejected ? 'partial' : 'completed', batchId,
        ],
      );
      await conn.query('COMMIT');

      const batchRow = await sql(conn, 'SELECT * FROM import_batch WHERE id = ?', [batchId]);
      const filesRow = await sql(conn, 'SELECT * FROM batch_file WHERE batch_id = ?', [batchId]);
      return {
        batch: rowToCamel(batchRow.toArray()[0]) as unknown as ImportBatch,
        files: filesRow.toArray().map((x) => rowToCamel(x)) as unknown as BatchFile[],
        issues: allIssues,
      };
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    }
  });
}

/** DuckDB 返回的 snake_case 行转 camelCase（仅用于元数据小表）。 */
function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}
