/**
 * DWS 指标服务：把 DWD 明细物化为日/月指标表。
 *
 * 指标口径（全部在 SQL 内完成，利用 DuckDB 的 arg_min/arg_max 保留极值发生时刻）：
 * - 日均水位 avg_level_m：当日有效水位采样的算术平均；
 * - 月极值：月内最大/最小水位及其发生时刻；
 * - 超警戒时长：每个超过 warning_level_m 的采样按站点期望采样间隔计时长后求和，
 *   最后一个超警戒采样按一个完整间隔计（记录仪口径：该值代表接下来一个间隔的状态）。
 *
 * 设计取舍：DWS 选择物化表而非纯视图——指标页查询量最大，物化后翻页/筛选零计算；
 * 每次导入或规则变更后手动点“重算指标”即可全量重建（数据量下全量重算只要几百毫秒）。
 */
import { sql, withConn } from '../db/connection.ts';
import { ensureSchema } from '../db/import-service.ts';

export interface DailyMetric {
  stationCode: string;
  statDate: string;
  avgLevelM: number | null;
  maxLevelM: number | null;
  maxLevelTs: string | null;
  minLevelM: number | null;
  minLevelTs: string | null;
  sampleCount: number;
  missingCount: number;
  overWarningMinutes: number;
}

export interface MonthlyMetric {
  stationCode: string;
  statMonth: string;
  maxLevelM: number | null;
  maxLevelTs: string | null;
  minLevelM: number | null;
  minLevelTs: string | null;
  avgLevelM: number | null;
  overWarningMinutes: number;
  sampleCount: number;
}

export async function rebuildMetrics(): Promise<{ dailyRows: number; monthlyRows: number }> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    await sql(conn, 'BEGIN TRANSACTION');
    try {
      await sql(conn, 'DELETE FROM dws_daily');
      await sql(conn, 'DELETE FROM dws_monthly');

      await sql(conn, `
        INSERT INTO dws_daily
        WITH base AS (
          SELECT
            d.station_code,
            CAST(d.ts_utc AT TIME ZONE 'UTC' AS DATE) AS stat_date,
            d.ts_utc,
            d.water_level_m,
            COALESCE(s.warning_level_m, 20.0) AS warn_level,
            COALESCE(s.expected_interval_min, 60) AS interval_min
          FROM dwd_water_record d
          LEFT JOIN station_config s ON s.station_code = d.station_code
        ),
        agg AS (
          SELECT
            station_code, stat_date,
            avg(water_level_m) AS avg_level_m,
            max(water_level_m) AS max_level_m,
            min(water_level_m) AS min_level_m,
            count(*) AS sample_count,
            count(*) FILTER (WHERE water_level_m IS NULL) AS missing_count,
            CAST(sum(CASE WHEN water_level_m > warn_level THEN interval_min ELSE 0 END) AS BIGINT)
              AS over_warning_minutes
          FROM base
          GROUP BY station_code, stat_date
        )
        SELECT
          a.station_code,
          a.stat_date,
          a.avg_level_m,
          a.max_level_m,
          (SELECT max(b.ts_utc) FROM base b
             WHERE b.station_code = a.station_code
               AND CAST(b.ts_utc AT TIME ZONE 'UTC' AS DATE) = a.stat_date
               AND b.water_level_m = a.max_level_m) AS max_level_ts,
          a.min_level_m,
          (SELECT min(b.ts_utc) FROM base b
             WHERE b.station_code = a.station_code
               AND CAST(b.ts_utc AT TIME ZONE 'UTC' AS DATE) = a.stat_date
               AND b.water_level_m = a.min_level_m) AS min_level_ts,
          a.sample_count,
          a.missing_count,
          a.over_warning_minutes
        FROM agg a
      `);

      await sql(conn, `
        INSERT INTO dws_monthly
        WITH m AS (
          SELECT station_code, strftime(stat_date, '%Y-%m') AS stat_month,
                 avg_level_m, max_level_m, min_level_m, max_level_ts, min_level_ts,
                 over_warning_minutes, sample_count
          FROM dws_daily
        )
        SELECT
          station_code,
          stat_month,
          max(max_level_m) AS max_level_m,
          arg_max(max_level_ts, max_level_m) AS max_level_ts,
          min(min_level_m) AS min_level_m,
          arg_min(min_level_ts, min_level_m) AS min_level_ts,
          avg(avg_level_m) AS avg_level_m,
          sum(over_warning_minutes) AS over_warning_minutes,
          sum(sample_count) AS sample_count
        FROM m
        GROUP BY station_code, stat_month
      `);
      const dailyRows = Number((await sql(conn, 'SELECT count(*)::INTEGER AS n FROM dws_daily')).toArray()[0].n);
      const monthlyRows = Number((await sql(conn, 'SELECT count(*)::INTEGER AS n FROM dws_monthly')).toArray()[0].n);
      await sql(conn, 'COMMIT');
      return { dailyRows, monthlyRows };
    } catch (err) {
      await sql(conn, 'ROLLBACK');
      throw err;
    }
  });
}

export async function queryDaily(station?: string, month?: string): Promise<DailyMetric[]> {
  return withConn(async (conn) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (station) { conds.push('station_code = ?'); params.push(station); }
    if (month) { conds.push("strftime(stat_date, '%Y-%m') = ?"); params.push(month); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await sql(conn, 
      `SELECT * FROM dws_daily ${where} ORDER BY station_code, stat_date DESC LIMIT 1000`,
      params,
    );
    return r.toArray().map((row) => ({
      stationCode: String(row.station_code),
      statDate: String(row.stat_date),
      avgLevelM: row.avg_level_m === null || row.avg_level_m === undefined ? null : Number(row.avg_level_m),
      maxLevelM: row.max_level_m === null || row.max_level_m === undefined ? null : Number(row.max_level_m),
      maxLevelTs: row.max_level_ts ? new Date(Number(row.max_level_ts)).toISOString() : null,
      minLevelM: row.min_level_m === null || row.min_level_m === undefined ? null : Number(row.min_level_m),
      minLevelTs: row.min_level_ts ? new Date(Number(row.min_level_ts)).toISOString() : null,
      sampleCount: Number(row.sample_count),
      missingCount: Number(row.missing_count),
      overWarningMinutes: Number(row.over_warning_minutes),
    }));
  });
}

export async function queryMonthly(station?: string): Promise<MonthlyMetric[]> {
  return withConn(async (conn) => {
    const r = await sql(conn, 
      `SELECT * FROM dws_monthly ${station ? 'WHERE station_code = ?' : ''}
       ORDER BY station_code, stat_month DESC LIMIT 500`,
      station ? [station] : [],
    );
    return r.toArray().map((row) => ({
      stationCode: String(row.station_code),
      statMonth: String(row.stat_month),
      maxLevelM: row.max_level_m === null || row.max_level_m === undefined ? null : Number(row.max_level_m),
      maxLevelTs: row.max_level_ts ? new Date(Number(row.max_level_ts)).toISOString() : null,
      minLevelM: row.min_level_m === null || row.min_level_m === undefined ? null : Number(row.min_level_m),
      minLevelTs: row.min_level_ts ? new Date(Number(row.min_level_ts)).toISOString() : null,
      avgLevelM: row.avg_level_m === null || row.avg_level_m === undefined ? null : Number(row.avg_level_m),
      overWarningMinutes: Number(row.over_warning_minutes),
      sampleCount: Number(row.sample_count),
    }));
  });
}
