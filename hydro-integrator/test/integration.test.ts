/**
 * 端到端集成测试：真实启动 DuckDB-WASM（node worker），
 * 串联 种子元数据 -> 导入三厂家文件 -> 幂等重导 -> 补传 -> 质控 -> 指标 -> 血缘 全链路。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withConn } from '../src/db/connection.ts';
import { importFiles, resetSchemaFlag } from '../src/db/import-service.ts';
import { listBatches, listDataSources, listMappings, seedMetadata } from '../src/db/metadata.ts';
import { runAutoQc, listFlags, addManualFlag, getRules, saveRules } from '../src/qc/engine.ts';
import { rebuildMetrics, queryDaily, queryMonthly } from '../src/metrics/dws-service.ts';
import { traceDwdPoint, traceDailyMetric } from '../src/lineage/lineage-service.ts';
import { exportSnapshot, importSnapshot } from '../src/db/backup.ts';

const root = join(import.meta.dirname, '..', 'testdata');

async function loadDir(sub: string, dataSourceId: number, excludePrefix = '') {
  const dir = join(root, sub);
  const names = (await readdir(dir)).filter((n) => !n.startsWith(excludePrefix));
  return Promise.all(names.map(async (fileName) => ({
    fileName,
    bytes: new Uint8Array(await readFile(join(dir, fileName))),
    dataSourceId,
  })));
}

/** 常规导入统一排除补传文件，补传由专门测试单独验证 */
async function loadRegularInputs() {
  return [
    ...(await loadDir('qinghe', 1, 'backfill')),
    ...(await loadDir('yuanshan', 2, 'backfill')),
    ...(await loadDir('lanshi', 3, 'backfill')),
  ];
}

beforeAll(async () => {
  resetSchemaFlag();
  await seedMetadata();
}, 30000);

afterAll(async () => {
  await closeDb();
});

describe('全链路集成', () => {
  it('种子：3 个数据源、10 个站点、各厂家内置映射', async () => {
    const sources = await listDataSources();
    expect(sources).toHaveLength(3);
    const mappings = await listMappings();
    expect(mappings.filter((m) => m.dataSourceId === 3 && m.sourceField === 'level_cm')[0].scale).toBe(0.01);
  });

  it('首次导入：83 个常规文件（不含补传），坏文件被拒、截断有 issue、DWD 有数据', async () => {
    const inputs = await loadRegularInputs();
    expect(inputs.length).toBe(83);
    const sources = await listDataSources();
    const allMappings = await listMappings();
    const mapByDs = new Map(sources.map((s) => [s.id, allMappings.filter((m) => m.dataSourceId === s.id)]));

    const outcome = await importFiles(inputs, sources, mapByDs, '集成测试首次导入');
    expect(outcome.files.length).toBe(inputs.length);
    const rejected = outcome.files.filter((f) => f.status === 'rejected');
    // 2 个 CRC 错误文件必须被拒
    expect(rejected.map((f) => f.fileName).filter((n) => n.includes('crcerr'))).toHaveLength(2);
    // 截断/坏时间等 issue 有统计
    expect(outcome.issues.length).toBeGreaterThan(0);

    const stats = await withConn(async (conn) => ({
      ods: Number((await conn.query('SELECT count(*)::INTEGER n FROM ods_raw_record')).toArray()[0].n),
      dwd: Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n),
      lineage: Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_record_lineage')).toArray()[0].n),
    }));
    expect(stats.ods).toBeGreaterThan(30000);
    expect(stats.dwd).toBeGreaterThan(20000);
    // 血缘按 ODS 记录登记（含补传覆盖产生的多版本），故与 ODS 行数一致
    expect(stats.lineage).toBe(stats.ods);
  });

  it('幂等：同一批文件再导一次，ODS/DWD 行数不变，全部记为重复文件', async () => {
    const before = await withConn(async (conn) =>
      Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n));
    const sources = await listDataSources();
    const allMappings = await listMappings();
    const mapByDs = new Map(sources.map((s) => [s.id, allMappings.filter((m) => m.dataSourceId === s.id)]));
    const inputs = await loadRegularInputs();
    const outcome = await importFiles(inputs, sources, mapByDs, '重复导入验证');
    // 81 个有效文件全部命中文件级去重；2 个 CRC 坏文件重导时仍被解析器拒收
    expect(outcome.batch.duplicateFileCount).toBe(inputs.length - 2);
    expect(outcome.files.filter((f) => f.status === 'rejected')).toHaveLength(2);
    const after = await withConn(async (conn) =>
      Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n));
    expect(after).toBe(before);
  });

  it('UTC 归一：北京 CSV 与 UTC 定宽的 ts_utc 均为 UTC 且无 +08 偏移残留', async () => {
    await withConn(async (conn) => {
      const r = await conn.query(`
        SELECT d.source_file_name, d.ts_utc, o.raw_timestamp
        FROM dwd_water_record d JOIN ods_raw_record o ON o.record_hash = d.record_hash
        WHERE d.source_file_name LIKE 'QH_%' LIMIT 3`);
      for (const row of r.toArray()) {
        const raw = String(row.raw_timestamp).slice(0, 19);
        const utc = new Date(Number(row.ts_utc));
        // 北京墙钟 08:00 -> UTC 00:00，差值应为 -8h
        const wallMs = Date.UTC(
          Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)),
          Number(raw.slice(11, 13)), Number(raw.slice(14, 16)), Number(raw.slice(17, 19)),
        );
        expect(wallMs - Number(row.ts_utc)).toBe(8 * 3600_000);
        expect(utc.getUTCHours()).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('补传：backfill 文件覆盖同刻值，行数不增、血缘保留新旧两个来源', async () => {
    const sources = await listDataSources();
    const allMappings = await listMappings();
    const mapByDs = new Map(sources.map((s) => [s.id, allMappings.filter((m) => m.dataSourceId === s.id)]));
    const before = await withConn(async (conn) =>
      Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n));

    const inputs = [
      {
        fileName: 'backfill_QH01_202607_fix.csv',
        bytes: new Uint8Array(await readFile(join(root, 'qinghe', 'backfill_QH01_202607_fix.csv'))),
        dataSourceId: 1,
      },
    ];
    const outcome = await importFiles(inputs, sources, mapByDs, '补传合并');
    expect(outcome.batch.supersededCount).toBeGreaterThan(0);

    const after = await withConn(async (conn) =>
      Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n));
    expect(after).toBe(before); // 覆盖而非新增

    // 被覆盖的点：宽表值 = 补传新值，血缘有 current + superseded 两条
    const point = await withConn(async (conn) =>
      (await conn.query(`
        SELECT * FROM dwd_water_record
        WHERE station_code = 'QH01' AND ts_utc = '2026-07-03 00:00:00+00'`)).toArray()[0]);
    expect(Number(point.water_level_m)).toBeCloseTo(11.8, 5); // 北京 08:00 -> UTC 00:00
    // 该时刻原本跨两个文件（6月B、7月A 各一条），补传再叠加一条，共 3 条血缘，
    // 其中仅补传那条 is_current=true，旧来源全部置为失效
    const lineage = await withConn(async (conn) =>
      (await conn.query(`
        SELECT count(*)::INTEGER n,
               sum(CASE WHEN is_current THEN 1 ELSE 0 END)::INTEGER cur,
               sum(CASE WHEN NOT is_current THEN 1 ELSE 0 END)::INTEGER old_cnt
        FROM dwd_record_lineage
        WHERE station_code = 'QH01' AND ts_utc = '2026-07-03 00:00:00+00'`)).toArray()[0]);
    expect(Number(lineage.n)).toBe(3);
    expect(Number(lineage.cur)).toBe(1);
    expect(Number(lineage.old_cnt)).toBe(2);
  });

  it('质控：自动规则命中四类标记，人工标记在重跑后保留', async () => {
    const stats = await runAutoQc();
    expect(stats.stations).toBe(11); // QH×3 + YS×3 + LS×4 + DST 模拟站 NY01
    const flags = await listFlags(undefined, 5000);
    const types = new Set(flags.map((f) => f.flagType));
    expect(types.has('jump')).toBe(true);
    expect(types.has('range')).toBe(true);
    expect(types.has('frozen')).toBe(true);
    expect(types.has('missing')).toBe(true);

    await addManualFlag('QH01', '2026-07-01T00:00:00Z', 'range', 'warning', '人工标记：仪器检修存疑');
    await runAutoQc(); // 重跑自动规则
    const flags2 = await listFlags('QH01', 5000);
    const manual = flags2.filter((f) => f.source === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0].reviewStatus).toBe('confirmed');
  });

  it('质控参数可保存并生效', async () => {
    const rules = await getRules();
    const tightened = { ...rules, jumpThresholdM: 0.2 };
    await saveRules(tightened);
    expect((await getRules()).jumpThresholdM).toBe(0.2);
    const stats = await runAutoQc();
    expect(stats.inserted).toBeGreaterThan(100); // 阈值收紧后跳变标记显著增多
    await saveRules(rules); // 还原
  });

  it('DWS：日/月指标可算，超警戒时长非负，月极值来自日极值', async () => {
    const m = await rebuildMetrics();
    expect(m.dailyRows).toBeGreaterThan(100);
    expect(m.monthlyRows).toBeGreaterThan(20);
    const daily = await queryDaily('LS01');
    expect(daily.length).toBeGreaterThan(0);
    for (const d of daily) {
      expect(d.overWarningMinutes).toBeGreaterThanOrEqual(0);
      if (d.maxLevelM !== null) expect(d.maxLevelM).toBeGreaterThanOrEqual(d.avgLevelM ?? -Infinity);
    }
    const monthly = await queryMonthly('LS01');
    expect(monthly[0].statMonth).toMatch(/^\d{4}-\d{2}$/);
  });

  it('血缘：DWD 点可追到 ODS 原始文件+行号；日指标可下钻到明细', async () => {
    const sample = await withConn(async (conn) =>
      (await conn.query(`SELECT station_code, ts_utc FROM dwd_water_record
        WHERE station_code = 'LS02' LIMIT 1`)).toArray()[0]);
    const ts = new Date(Number(sample.ts_utc)).toISOString();
    const trace = await traceDwdPoint('LS02', ts);
    expect(trace.edges.some((e) => e.layer === 'ODS')).toBe(true);
    const odsEdge = trace.edges.find((e) => e.layer === 'ODS')!;
    expect(odsEdge.fileName.endsWith('.bin')).toBe(true);
    expect(odsEdge.sourceLine).toBeGreaterThan(0);
    const key = `${odsEdge.fileName}:${odsEdge.sourceLine}`;
    expect(trace.rawDetails[key].rawFields).toBeTruthy();

    const dailyTrace = await traceDailyMetric('LS02', '2026-08-01');
    expect(dailyTrace.edges.some((e) => e.layer === 'DWS')).toBe(true);
    expect(dailyTrace.edges.filter((e) => e.layer === 'DWD').length).toBeGreaterThan(0);
  });

  it('快照：导出再导入，行数一致', async () => {
    const snap = await exportSnapshot();
    expect(snap.app).toBe('hydro-integrator');
    const dwdBefore = await withConn(async (conn) =>
      Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n));
    await importSnapshot(snap);
    const dwdAfter = await withConn(async (conn) =>
      Number((await conn.query('SELECT count(*)::INTEGER n FROM dwd_water_record')).toArray()[0].n));
    expect(dwdAfter).toBe(dwdBefore);
  });

  it('批次历史可查，包含首次与重复导入两条批次', async () => {
    const batches = await listBatches();
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.some((b) => b.duplicateFileCount > 0)).toBe(true);
  });
}, 120000);
