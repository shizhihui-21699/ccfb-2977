/**
 * 数据库导出/导入：内存 DuckDB 的持久化方案。
 *
 * 为什么不用 OPFS DuckDB 原生持久化：
 * - Safari 对 OPFS 同步句柄支持受限，file:// 打开页面时完全不可用；
 * - 本工具的运维形态是“月度拼表后下载一份快照归档”，JSON 快照更贴合，
 *   也方便人工核查、跨机器迁移、纳入单位的文件备份体系。
 *
 * 导出内容按表逐个 toArray 成 JSON；导入时按外键依赖顺序重建。
 */
import { sql, withConn } from './connection.ts';
import { ensureSchema } from './import-service.ts';

const TABLES_IN_ORDER = [
  'data_source',
  'field_mapping',
  'station_config',
  'import_batch',
  'batch_file',
  'ods_raw_record',
  'dwd_water_record',
  'dwd_record_lineage',
  'qc_rule_config',
  'qc_flag',
  'dws_daily',
  'dws_monthly',
] as const;

export interface Snapshot {
  app: 'hydro-integrator';
  version: 1;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportSnapshot(): Promise<Snapshot> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const t of TABLES_IN_ORDER) {
      const r = await sql(conn, `SELECT * FROM ${t}`);
      tables[t] = r.toArray().map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          // BigInt -> 字符串，TIMESTAMP -> 毫秒数字，保证 JSON 安全
          if (typeof v === 'bigint') out[k] = v.toString();
          else if (v instanceof Date) out[k] = v.getTime();
          else out[k] = v;
        }
        return out;
      });
    }
    return {
      app: 'hydro-integrator',
      version: 1,
      exportedAt: new Date().toISOString(),
      tables,
    };
  });
}

export async function importSnapshot(snapshot: Snapshot): Promise<void> {
  if (snapshot.app !== 'hydro-integrator' || snapshot.version !== 1) {
    throw new Error('快照格式不被识别（app/version 不匹配）');
  }
  const arrow = await import('apache-arrow');
  await withConn(async (conn) => {
    await ensureSchema(conn);
    // 注意：不能包在单个显式事务里——duckdb-wasm 在事务内连续 DELETE 多张
    // 带外键的表会误报 FK 违约；autocommit 逐条删除行为正确。
    const DELETE_ORDER = [
      'dws_monthly', 'dws_daily',
      'qc_flag', 'qc_rule_config',
      'dwd_record_lineage', 'dwd_water_record',
      'ods_raw_record', 'batch_file', 'import_batch',
      'station_config', 'field_mapping', 'data_source',
    ];
    for (const t of DELETE_ORDER) {
      await sql(conn, `DELETE FROM ${t}`);
    }

    for (const t of TABLES_IN_ORDER) {
      const rows = snapshot.tables[t] ?? [];
      if (rows.length === 0) continue;

      // 取目标表真实列名与类型，按列名对齐，避免依赖 JS 对象键序
      const info = await sql(conn,
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = ? ORDER BY ordinal_position`, [t]);
      const cols = info.toArray().map((r) => ({
        name: String(r.column_name),
        type: String(r.data_type).toUpperCase(),
      }));

      // 全部转字符串走全 VARCHAR 临时表，再按目标类型 CAST，规避 Arrow 类型推断差异
      const arrays: Record<string, (string | null)[]> = {};
      for (const { name, type } of cols) {
        arrays[name] = rows.map((row) => {
          const v = row[name];
          if (v === null || v === undefined) return null;
          // 导出时时间被转成毫秒数字，这里还原为 ISO 字符串供 TIMESTAMP CAST
          if (type.includes('TIMESTAMP') || type === 'DATE') {
            return new Date(Number(v)).toISOString();
          }
          return String(v);
        });
      }
      const table = arrow.tableFromArrays(arrays);
      const ipc = arrow.tableToIPC(table, 'stream');
      // 列名统一加双引号，offset 等是 DuckDB 保留字
      const quoted = cols.map((c) => `"${c.name}"`);
      await conn.query(`CREATE OR REPLACE TEMP TABLE snap_stage (${
        cols.map((c) => `"${c.name}" VARCHAR`).join(', ')
      })`);
      await conn.insertArrowFromIPCStream(ipc, { name: 'snap_stage', create: false });
      const selectList = cols.map((c) => {
        const q = `"${c.name}"`;
        if (c.type.includes('TIMESTAMP')) return `CAST(${q} AS TIMESTAMP WITH TIME ZONE)`;
        if (c.type === 'DATE') return `CAST(${q} AS DATE)`;
        if (c.type.includes('INT') || c.type === 'BIGINT') return `CAST(NULLIF(${q},'') AS ${c.type})`;
        if (c.type.includes('DOUBLE') || c.type.includes('FLOAT') || c.type === 'REAL')
          return `CAST(NULLIF(${q},'') AS DOUBLE)`;
        if (c.type === 'JSON') return `CAST(${q} AS JSON)`;
        if (c.type === 'BOOLEAN') return `CAST(${q} AS BOOLEAN)`;
        return q;
      }).join(', ');
      await sql(conn, `INSERT INTO ${t} (${quoted.join(', ')}) SELECT ${selectList} FROM snap_stage`);
      await conn.query('DROP TABLE snap_stage');
    }
  });
}
