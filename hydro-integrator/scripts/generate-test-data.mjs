/**
 * 测试数据生成器（Node 脚本，与应用代码共享格式定义）。
 *
 * 产出（testdata/ 下三个厂家目录，各 32 个文件，共 96 个）：
 * - qinghe/   清河 CSV，北京时间，每文件约 1 个月的 60 分钟采样
 * - yuanshan/ 远山定宽文本，UTC，30 分钟采样
 * - lanshi/   蓝石 HYDROBIN 二进制，10/15 分钟采样
 *
 * 故意植入的异常：
 * - 每厂家 2 个截断文件（CSV 少列 / 定宽断行 / 二进制短字节）
 * - 蓝石 2 个 CRC 错误文件（翻转数据区字节后保留原 CRC）
 * - 每厂家 1 个补传文件（backfill_ 前缀，覆盖若干既有时间点并修正数值）
 * - 清河 1 个 DST 重复时刻文件（时区取 America/New_York 的模拟站，验证 fold 消歧）
 * - 随机缺测、超量程、跳变、冻结片段，供质控规则命中
 *
 * 用法：node scripts/generate-test-data.mjs [输出目录]
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 直连 TS 源文件会缺编译器，这里把二进制格式常量内联（与 src/parsers/binary-codec.ts 保持一致）
const HEADER_SIZE = 32;
const RECORD_SIZE = 18;
const TRAILER_SIZE = 12;
const FLAG_UTC_EPOCH = 0x0001;
const SENTINEL_LEVEL = -32768;
const SENTINEL_USHORT = 65535;
const SENTINEL_U8 = 255;

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = process.argv[2] ?? join(here, '..', 'testdata');

// ---- 可复现“随机”：线性同余，保证每次生成的异常位置一致 ----
let seed = 20261114;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function bjtParts(d) {
  // 传入的 Date 已按 UTC+8 对齐到整点，直接读 UTC 部件即为北京墙钟
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function utcIso(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** 平滑水位基线 + 缓慢日周期，叠加少量噪声与指定异常 */
function levelAt(d, base, anomaly = {}) {
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  let v = base + 1.2 * Math.sin((hour - 3) / 24 * Math.PI * 2) + (rnd() - 0.5) * 0.08;
  if (anomaly.spike) v += anomaly.spike;
  if (anomaly.frozen !== undefined) v = anomaly.frozen;
  return v;
}

async function main() {
  await rm(outRoot, { recursive: true, force: true });
  const dirs = {
    qinghe: join(outRoot, 'qinghe'),
    yuanshan: join(outRoot, 'yuanshan'),
    lanshi: join(outRoot, 'lanshi'),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const months = [];
  for (let m = 0; m < 4; m++) months.push(new Date(Date.UTC(2026, 5 + m, 1))); // 2026-06 .. 2026-09

  await genQinghe(dirs.qinghe, months);
  await genYuanshan(dirs.yuanshan, months);
  await genLanshi(dirs.lanshi, months);

  // 生成数据清单，方便界面与测试核对
  const manifest = { generatedAt: new Date().toISOString(), root: outRoot, counts: await countFiles(dirs) };
  await writeFile(join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('测试数据已生成：', manifest);
}

async function countFiles(dirs) {
  const { readdir } = await import('node:fs/promises');
  const out = {};
  for (const [k, d] of Object.entries(dirs)) out[k] = (await readdir(d)).length;
  return out;
}

// ---------------- 清河 CSV（北京时间，60 分钟）----------------
async function genQinghe(dir, months) {
  const stations = ['QH01', 'QH02', 'QH03'];
  let fileIdx = 0;
  for (const station of stations) {
    const base = station === 'QH01' ? 12 : station === 'QH02' ? 18 : 15;
    for (let mi = 0; mi < months.length; mi++) {
      for (let half = 0; half < 2; half++) {
        fileIdx++;
        const kind = [11, 22].includes(fileIdx) ? 'truncated' : fileIdx === 13 ? 'badts' : 'normal';
        const name = `QH_${station}_2026${pad(6 + mi)}_${half ? 'B' : 'A'}.csv`;
        const lines = ['时间,站码,水位(m),流量(m3/s),降雨量(mm),电压(V),质量码'];
        const start = new Date(months[mi]);
        if (half) start.setUTCDate(16);
        const end = half ? nextMonth(start) : new Date(start);
        end.setUTCDate(16);
        let frozenVal;
        let frozenLeft = 0;
        for (let t = new Date(start); t < end; t.setUTCHours(t.getUTCHours() + 1)) {
          // 北京墙钟 = UTC+8，生成时刻直接把 UTC 部件当墙钟输出需偏移 8 小时
          const wall = new Date(t.getTime() + 8 * 3600_000);
          const anomaly = {};
          if (rnd() < 0.03) anomaly.spike = 2.5;                 // 跳变
          if (rnd() < 0.01) { frozenVal = base + 0.5; frozenLeft = 8; }
          if (frozenLeft > 0) { anomaly.frozen = frozenVal; frozenLeft--; }
          const level = levelAt(wall, base, anomaly);
          const missing = rnd() < 0.04;
          const flow = missing ? '' : (2 + rnd() * 3).toFixed(2);
          const rain = rnd() < 0.1 ? (rnd() * 2).toFixed(1) : '0.0';
          const voltage = (11.5 + rnd() * 1.5).toFixed(1);
          const qc = rnd() < 0.02 ? '1' : '0';
          if (kind === 'badts' && lines.length === 2) {
            lines.push(`时间无法解析,${station},${level.toFixed(2)},${flow},${rain},${voltage},${qc}`);
            continue;
          }
          if (kind === 'truncated' && lines.length === 40) {
            lines.push(`${bjtParts(wall)},${station},${level.toFixed(2)},${flow}`); // 故意少列
            break;
          }
          lines.push(`${bjtParts(wall)},${station},${missing ? '' : level.toFixed(2)},${flow},${rain},${voltage},${qc}`);
        }
        await writeFile(join(dir, name), lines.join('\n') + '\n', 'utf8');
      }
    }
  }

  // 补传文件：覆盖 QH01 七月上旬若干时刻，水位修正 -0.30
  await writeFile(join(dir, 'backfill_QH01_202607_fix.csv'), [
    '时间,站码,水位(m),流量(m3/s),降雨量(mm),电压(V),质量码',
    '2026-07-03 08:00:00,QH01,11.80,2.50,0.0,12.0,0',
    '2026-07-03 09:00:00,QH01,11.95,2.60,0.0,12.0,0',
    '2026-07-03 10:00:00,QH01,12.10,2.55,0.0,12.1,0',
  ].join('\n') + '\n', 'utf8');

  // 超量程样本：水位越过 50m 上限/出现负值、电压越过 16V 上限，稳定命中 range 规则
  await writeFile(join(dir, 'out_of_range_QH02.csv'), [
    '时间,站码,水位(m),流量(m3/s),降雨量(mm),电压(V),质量码',
    '2026-09-10 08:00:00,QH02,53.80,4.10,0.0,12.4,0',
    '2026-09-10 09:00:00,QH02,54.20,4.20,0.0,17.8,0',
    '2026-09-10 10:00:00,QH02,-1.50,4.00,0.0,12.3,0',
    '2026-09-10 11:00:00,QH02,21.90,4.05,0.0,12.4,0',
  ].join('\n') + '\n', 'utf8');

  // DST fold 样本：模拟 America/New_York 站，2026-11-01 01:00 墙钟出现两次
  await writeFile(join(dir, 'dst_fold_NY01.csv'), [
    '时间,站码,水位(m),流量(m3/s),降雨量(mm),电压(V),质量码',
    '2026-11-01 00:30:00,NY01,5.10,1.20,0.0,12.2,0',
    '2026-11-01 01:00:00,NY01,5.12,1.21,0.0,12.2,0',
    '2026-11-01 01:30:00,NY01,5.13,1.22,0.0,12.1,0',
    '2026-11-01 01:00:00,NY01,5.09,1.18,0.0,12.1,0',
    '2026-11-01 01:30:00,NY01,5.08,1.17,0.0,12.1,0',
    '2026-11-01 02:00:00,NY01,5.05,1.15,0.0,12.0,0',
  ].join('\n') + '\n', 'utf8');
}

// ---------------- 远山定宽（UTC，30 分钟）----------------
async function genYuanshan(dir, months) {
  const stations = ['YS01', 'YS02', 'YS03'];
  let fileIdx = 0;
  for (const station of stations) {
    const base = station === 'YS01' ? 40 : station === 'YS02' ? 36 : 33;
    for (let mi = 0; mi < months.length; mi++) {
      for (let half = 0; half < 2; half++) {
        fileIdx++;
        const truncated = [12, 24].includes(fileIdx);
        const name = `YS_${station}_2026${pad(6 + mi)}_${half ? 'B' : 'A'}.txt`;
        const lines = [];
        const start = new Date(months[mi]);
        if (half) start.setUTCDate(16);
        const end = half ? nextMonth(start) : new Date(start);
        end.setUTCDate(16);
        let frozenLeft = 0;
        let frozenVal;
        for (let t = new Date(start); t < end; t.setUTCMinutes(t.getUTCMinutes() + 30)) {
          const anomaly = {};
          if (rnd() < 0.02) anomaly.spike = 2.2;
          if (rnd() < 0.008) { frozenVal = base - 1; frozenLeft = 10; }
          if (frozenLeft > 0) { anomaly.frozen = frozenVal; frozenLeft--; }
          const level = levelAt(t, base, anomaly);
          const missing = rnd() < 0.04;
          const flow = rnd() < 0.01 ? 9999.0 : 3 + rnd() * 4;
          const voltage = rnd() < 0.01 ? 99.0 : 11 + rnd() * 2;
          const qc = rnd() < 0.03 ? 99 : 0;
          const line =
            station.padEnd(9) +
            utcIso(t) +
            (missing ? '  9999.00' : level.toFixed(2).padStart(9)) +
            flow.toFixed(2).padStart(9) +
            (rnd() * 1.5).toFixed(2).padStart(9) +
            (voltage === 99 ? '  99.00' : voltage.toFixed(2).padStart(7)) +
            (qc === 99 ? ' 99' : String(qc).padStart(3));
          if (truncated && lines.length === 30) {
            lines.push(line.slice(0, 40)); // 拦腰截断
            break;
          }
          lines.push(line);
        }
        await writeFile(join(dir, name), lines.join('\n') + '\n', 'utf8');
      }
    }
  }

  await writeFile(join(dir, 'backfill_YS01_202608_fix.txt'), [
    'YS01     2026-08-05T12:00:00Z    39.10     5.10     0.00  12.20  0',
    'YS01     2026-08-05T12:30:00Z    39.22     5.12     0.00  12.20  0',
  ].join('\n') + '\n', 'utf8');
}

// ---------------- 蓝石二进制（10/15 分钟）----------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeTrailer(crc) {
  const buf = new ArrayBuffer(TRAILER_SIZE);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  new TextEncoder().encodeInto('HYDROEND', u8);
  dv.setUint32(8, crc >>> 0, true);
  return u8;
}

function encodeRecord(r) {
  const buf = new ArrayBuffer(RECORD_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, r.epoch, true);
  dv.setInt16(4, r.levelCm ?? SENTINEL_LEVEL, true);
  dv.setUint16(6, r.flowDLps ?? SENTINEL_USHORT, true);
  dv.setUint16(8, r.rain10um ?? SENTINEL_USHORT, true);
  dv.setUint8(10, r.voltageDV ?? SENTINEL_U8);
  dv.setUint8(11, r.qc ?? SENTINEL_U8);
  return new Uint8Array(buf);
}

function encodeHydro({ station, intervalMin, records, utcEpoch }) {
  const body = new Uint8Array(HEADER_SIZE + records.length * RECORD_SIZE);
  const dv = new DataView(body.buffer);
  new TextEncoder().encodeInto('HYDROBIN', body);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, utcEpoch ? FLAG_UTC_EPOCH : 0, true);
  new TextEncoder().encodeInto(station, body.subarray(12, 20));
  dv.setUint16(20, intervalMin, true);
  dv.setUint32(22, records.length, true);
  records.forEach((r, i) => {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    dv.setUint32(off, r.epoch, true);
    dv.setInt16(off + 4, r.levelCm ?? SENTINEL_LEVEL, true);
    dv.setUint16(off + 6, r.flowDLps ?? SENTINEL_USHORT, true);
    dv.setUint16(off + 8, r.rain10um ?? SENTINEL_USHORT, true);
    dv.setUint8(off + 10, r.voltageDV ?? SENTINEL_U8);
    dv.setUint8(off + 11, r.qc ?? SENTINEL_U8);
  });
  const crc = crc32(body);
  const full = new Uint8Array(body.length + TRAILER_SIZE);
  full.set(body);
  new TextEncoder().encodeInto('HYDROEND', full.subarray(body.length));
  new DataView(full.buffer).setUint32(body.length + 8, crc, true);
  return full;
}

async function genLanshi(dir, months) {
  const stations = [
    { code: 'LS01', interval: 10, base: 6, utcEpoch: false },
    { code: 'LS02', interval: 15, base: 10, utcEpoch: true },
    { code: 'LS03', interval: 15, base: 13, utcEpoch: false },
    { code: 'LS04', interval: 10, base: 8, utcEpoch: true },
  ];
  let fileIdx = 0;
  for (const st of stations) {
    for (let mi = 0; mi < months.length; mi++) {
      for (let half = 0; half < 2; half++) {
        fileIdx++;
        const mode = [17, 27].includes(fileIdx) ? 'crcbad' : [19, 29].includes(fileIdx) ? 'truncated' : 'normal';
        const start = new Date(months[mi]);
        if (half) start.setUTCDate(16);
        const end = half ? nextMonth(start) : new Date(start);
        end.setUTCDate(16);
        const records = [];
        let frozenLeft = 0;
        for (let t = new Date(start); t < end; t.setUTCMinutes(t.getUTCMinutes() + st.interval)) {
          const anomaly = {};
          if (rnd() < 0.02) anomaly.spike = 2.0;
          if (rnd() < 0.01) frozenLeft = 8;
          if (frozenLeft > 0) { anomaly.frozen = st.base + 0.3; frozenLeft--; }
          const level = levelAt(t, st.base, anomaly);
          const missing = rnd() < 0.04;
          let epochSec;
          if (st.utcEpoch) {
            epochSec = Math.floor(t.getTime() / 1000);
          } else {
            // 北京伪 epoch：把 UTC+8 墙钟当作 UTC 计秒
            epochSec = Math.floor((t.getTime() + 8 * 3600_000) / 1000);
          }
          records.push({
            epoch: epochSec,
            levelCm: missing ? null : Math.round(level * 100),
            flowDLps: Math.round((2 + rnd() * 5) * 10),
            rain10um: Math.round(rnd() * 1000),
            voltageDV: Math.round((11 + rnd() * 2) * 10),
            qc: 0,
          });
        }
        let bytes = encodeHydro({ station: st.code, intervalMin: st.interval, records, utcEpoch: st.utcEpoch });
        const suffix = mode === 'crcbad' ? '_crcerr' : mode === 'truncated' ? '_trunc' : '';
        const name = `LS_${st.code}_2026${pad(6 + mi)}_${half ? 'B' : 'A'}${suffix}.bin`;
        if (mode === 'crcbad') {
          // 翻转数据区一条记录的水位字节，但 CRC 保持原值 -> 校验必失败
          bytes[HEADER_SIZE + 4] ^= 0xff;
        }
        if (mode === 'truncated') {
          // 重打包：header 声明的记录数比实际多 3 条，trailer 与 CRC 仍然自洽，
          // 用来验证“CRC 通过但记录区短少”时完整记录入库、截断点报错的路径
          const shortRecords = records.slice(0, records.length - 3);
          const body = new Uint8Array(HEADER_SIZE + shortRecords.length * RECORD_SIZE);
          body.set(bytes.subarray(0, HEADER_SIZE)); // 原 header 已声明原始（更大）记录数
          shortRecords.forEach((r, i) => {
            body.set(encodeRecord(r), HEADER_SIZE + i * RECORD_SIZE);
          });
          const trailer2 = encodeTrailer(crc32(body));
          const rebuilt = new Uint8Array(body.length + trailer2.length);
          rebuilt.set(body);
          rebuilt.set(trailer2, body.length);
          bytes = rebuilt;
        }
        await writeFile(join(dir, name), bytes);
      }
    }
  }

  // 补传：LS02 八月初两个时刻的修正值（UTC epoch 站）
  const t1 = Date.UTC(2026, 7, 3, 2, 0);
  const t2 = Date.UTC(2026, 7, 3, 2, 15);
  await writeFile(
    join(dir, 'backfill_LS02_202608_fix.bin'),
    encodeHydro({
      station: 'LS02', intervalMin: 15, utcEpoch: true,
      records: [
        { epoch: t1 / 1000, levelCm: 955, flowDLps: 310, rain10um: 0, voltageDV: 121, qc: 0 },
        { epoch: t2 / 1000, levelCm: 960, flowDLps: 312, rain10um: 0, voltageDV: 121, qc: 0 },
      ],
    }),
  );

  // 给校验逻辑自测用：一个保证完好的小样例
  await writeFile(
    join(dir, 'sample_good_LS01.bin'),
    encodeHydro({
      station: 'LS01', intervalMin: 10, utcEpoch: false,
      records: [
        { epoch: Math.floor((Date.UTC(2026, 5, 1, 0, 0) + 8 * 3600_000) / 1000), levelCm: 612, flowDLps: 250, rain10um: 0, voltageDV: 120, qc: 0 },
      ],
    }),
  );
}

function nextMonth(d) {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + 1);
  return n;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
