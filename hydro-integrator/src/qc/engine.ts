/**
 * 质控规则引擎。
 *
 * 四类自动规则（均可在界面调参数，存 qc_rule_config 单行表）：
 * 1. range   超量程：水位/流量/电压超出配置量程；
 * 2. jump    跳变：与同站前一有效采样的水位差超过阈值（按相邻采样比较，
 *             缺测造成的大间隔不参与，避免把“隔了很久的两个点”误判为跳变）；
 * 3. frozen  长时间不变：连续 frozen_count 个有效水位值完全相同；
 * 4. missing 缺测：按站点期望间隔生成理论时间栅格，实际数据缺口超过
 *             missing_tolerance_intervals 个间隔，给缺口后的第一个理论时刻打标。
 *
 * 人工标记（source='manual'）独立于自动规则存在；重跑自动规则时
 * 只删除 source='auto' 的标记，人工标记与复核状态不受影响。
 */
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { QcFlag, QcFlagType, QcRuleConfig, QcSeverity } from '../types.ts';
import { sql, withConn } from '../db/connection.ts';
import { ensureSchema } from '../db/import-service.ts';

const DEFAULT_RULES: QcRuleConfig = {
  expectedIntervalMin: 60,
  missingToleranceIntervals: 2,
  jumpThresholdM: 1.5,
  levelRange: [0, 50],
  flowRange: [0, 500],
  voltageRange: [9, 16],
  frozenCount: 6,
  warningLevelM: 20,
};

export async function getRules(): Promise<QcRuleConfig> {
  return withConn(async (conn) => {
    await ensureSchema(conn);
    const r = await sql(conn, 'SELECT * FROM qc_rule_config WHERE id = 1');
    const row = r.toArray()[0];
    if (!row) return { ...DEFAULT_RULES };
    return {
      expectedIntervalMin: Number(row.expected_interval_min),
      missingToleranceIntervals: Number(row.missing_tolerance_intervals),
      jumpThresholdM: Number(row.jump_threshold_m),
      levelRange: [Number(row.level_min), Number(row.level_max)],
      flowRange: [Number(row.flow_min), Number(row.flow_max)],
      voltageRange: [Number(row.voltage_min), Number(row.voltage_max)],
      frozenCount: Number(row.frozen_count),
      warningLevelM: Number(row.warning_level_m),
    };
  });
}

export async function saveRules(rules: QcRuleConfig): Promise<void> {
  await withConn(async (conn) => {
    await sql(conn, 
      `UPDATE qc_rule_config SET expected_interval_min = ?, missing_tolerance_intervals = ?,
         jump_threshold_m = ?, level_min = ?, level_max = ?, flow_min = ?, flow_max = ?,
         voltage_min = ?, voltage_max = ?, frozen_count = ?, warning_level_m = ?
       WHERE id = 1`,
      [
        rules.expectedIntervalMin, rules.missingToleranceIntervals, rules.jumpThresholdM,
        rules.levelRange[0], rules.levelRange[1], rules.flowRange[0], rules.flowRange[1],
        rules.voltageRange[0], rules.voltageRange[1], rules.frozenCount, rules.warningLevelM,
      ],
    );
  });
}

export interface QcRunStats {
  inserted: number;
  stations: number;
}

/** 对全量 DWD 数据重跑自动规则（人工标记保留）。 */
export async function runAutoQc(): Promise<QcRunStats> {
  const rules = await getRules();
  return withConn(async (conn) => {
    await ensureSchema(conn);
    await sql(conn, "DELETE FROM qc_flag WHERE source = 'auto'");

    const stations = (await sql(conn, 
      'SELECT DISTINCT station_code FROM dwd_water_record ORDER BY 1',
    )).toArray().map((r) => String(r.station_code));

    let inserted = 0;
    for (const station of stations) {
      const rows = (await sql(conn, 
        `SELECT ts_utc, water_level_m, flow_m3s, voltage_v
         FROM dwd_water_record WHERE station_code = ? ORDER BY ts_utc`,
        [station],
      )).toArray();
      if (rows.length === 0) continue;

      let prevLevel: number | null = null;
      let prevTs: number | null = null;
      let frozenRun = 0;
      let lastLevel: number | null = null;
      let lastActualTs: number | null = null;

      for (const row of rows) {
        const tsMs = Number(row.ts_utc);
        const level = row.water_level_m === null || row.water_level_m === undefined ? null : Number(row.water_level_m);
        const flow = row.flow_m3s === null || row.flow_m3s === undefined ? null : Number(row.flow_m3s);
        const voltage = row.voltage_v === null || row.voltage_v === undefined ? null : Number(row.voltage_v);
        const tsIso = new Date(tsMs).toISOString();

        // --- 超量程 ---
        if (level !== null && (level < rules.levelRange[0] || level > rules.levelRange[1])) {
          await insertFlag(conn, station, tsIso, 'range', 'error',
            `水位 ${level.toFixed(2)}m 超出量程 [${rules.levelRange[0]}, ${rules.levelRange[1]}]`);
          inserted++;
        }
        if (flow !== null && (flow < rules.flowRange[0] || flow > rules.flowRange[1])) {
          await insertFlag(conn, station, tsIso, 'range', 'error',
            `流量 ${flow.toFixed(2)}m³/s 超出量程 [${rules.flowRange[0]}, ${rules.flowRange[1]}]`);
          inserted++;
        }
        if (voltage !== null && (voltage < rules.voltageRange[0] || voltage > rules.voltageRange[1])) {
          await insertFlag(conn, station, tsIso, 'range', 'warning',
            `电压 ${voltage.toFixed(2)}V 超出量程 [${rules.voltageRange[0]}, ${rules.voltageRange[1]}]`);
          inserted++;
        }

        // --- 跳变（仅在相邻期望间隔内比较，跨缺口不比）---
        if (level !== null && prevLevel !== null && prevTs !== null) {
          const gapMin = (tsMs - prevTs) / 60000;
          if (gapMin <= rules.expectedIntervalMin * 1.5 && Math.abs(level - prevLevel) > rules.jumpThresholdM) {
            await insertFlag(conn, station, tsIso, 'jump', 'error',
              `水位跳变 ${(level - prevLevel).toFixed(2)}m，超过阈值 ${rules.jumpThresholdM}m`);
            inserted++;
          }
        }

        // --- 冻结：连续 N 个有效水位完全相同 ---
        if (level !== null) {
          if (lastLevel !== null && level === lastLevel) {
            frozenRun++;
          } else {
            frozenRun = 1;
          }
          if (frozenRun === rules.frozenCount) {
            await insertFlag(conn, station, tsIso, 'frozen', 'warning',
              `水位连续 ${rules.frozenCount} 个采样保持 ${level.toFixed(2)}m 不变`);
            inserted++;
          } else if (frozenRun > rules.frozenCount) {
            await insertFlag(conn, station, tsIso, 'frozen', 'warning',
              `水位持续冻结（${frozenRun} 个采样）`);
            inserted++;
          }
          lastLevel = level;
        }

        // --- 缺测：与上一个实际采样的间隔超过容忍窗口 ---
        if (lastActualTs !== null) {
          const gapMin = (tsMs - lastActualTs) / 60000;
          if (gapMin > rules.expectedIntervalMin * (rules.missingToleranceIntervals + 1)) {
            const missingIso = new Date(
              lastActualTs + rules.expectedIntervalMin * rules.missingToleranceIntervals * 60000,
            ).toISOString();
            await insertFlag(conn, station, missingIso, 'missing', 'error',
              `缺测：距上一采样 ${Math.round(gapMin)} 分钟，超过容忍窗口`);
            inserted++;
          }
        }

        if (level !== null) prevLevel = level;
        prevTs = tsMs;
        lastActualTs = tsMs;
      }
    }

    return { inserted, stations: stations.length };
  });
}

async function insertFlag(
  conn: AsyncDuckDBConnection,
  station: string, tsIso: string, type: QcFlagType, severity: QcSeverity, message: string,
): Promise<void> {
  await sql(conn, 
    `INSERT INTO qc_flag (id, station_code, ts_utc, flag_type, severity, source, message)
     VALUES (nextval('seq_qc'), ?, ?, ?, ?, 'auto', ?)
     ON CONFLICT (station_code, ts_utc, flag_type, source) DO NOTHING`,
    [station, tsIso, type, severity, message],
  );
}

export async function listFlags(station?: string, limit = 500): Promise<QcFlag[]> {
  return withConn(async (conn) => {
    const r = station
      ? await sql(conn, 
        'SELECT * FROM qc_flag WHERE station_code = ? ORDER BY ts_utc DESC, id DESC LIMIT ?',
        [station, limit],
      )
      : await sql(conn, 'SELECT * FROM qc_flag ORDER BY ts_utc DESC, id DESC LIMIT ?', [limit]);
    return r.toArray().map((row) => ({
      id: Number(row.id),
      stationCode: String(row.station_code),
      tsUtc: new Date(Number(row.ts_utc)).toISOString(),
      flagType: String(row.flag_type) as QcFlagType,
      severity: String(row.severity) as QcSeverity,
      source: String(row.source) as QcFlag['source'],
      message: String(row.message),
      reviewStatus: String(row.review_status) as QcFlag['reviewStatus'],
      reviewer: row.reviewer ? String(row.reviewer) : null,
      reviewedAt: row.reviewed_at ? new Date(Number(row.reviewed_at)).toISOString() : null,
      createdAt: new Date(Number(row.created_at)).toISOString(),
    }));
  });
}

/** 人工加标 / 改标。 */
export async function addManualFlag(
  station: string, tsUtc: string, flagType: QcFlagType, severity: QcSeverity, message: string,
): Promise<void> {
  await withConn(async (conn) => {
    await sql(conn, 
      `INSERT INTO qc_flag (id, station_code, ts_utc, flag_type, severity, source, message, review_status)
       VALUES (nextval('seq_qc'), ?, ?, ?, ?, 'manual', ?, 'confirmed')
       ON CONFLICT (station_code, ts_utc, flag_type, source)
       DO UPDATE SET severity = excluded.severity, message = excluded.message,
         review_status = 'confirmed', reviewed_at = now()`,
      [station, tsUtc, flagType, severity, message],
    );
  });
}

/** 人工复核：确认 / 清除标记。清除 auto 标记时置 cleared 而不是物理删除，保留审计痕迹。 */
export async function reviewFlag(id: number, action: 'confirmed' | 'cleared', reviewer: string): Promise<void> {
  await withConn(async (conn) => {
    await sql(conn, 
      `UPDATE qc_flag SET review_status = ?, reviewer = ?, reviewed_at = now() WHERE id = ?`,
      [action, reviewer, id],
    );
  });
}
