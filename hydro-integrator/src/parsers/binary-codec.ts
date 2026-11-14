/**
 * 蓝石（Lanshi）厂家二进制记录仪格式 HYDROBIN v1。
 *
 * 文件布局（小端序）：
 * +---------------- header 32B ----------------+
 * | magic "HYDROBIN" 8B | version u16 | flags u16 |
 * | station_id  char[8]（不足补 0x00）            |
 * | interval_min u16 | record_count u32 | reserved u64 |
 * +---------------- records --------------------+
 * | 每条 18B：ts_epoch_s u32 | level_cm i16 | flow_dLps u16 |
 * |            rain_10um u16 | voltage_dV u8 | qc u8 |
 * |            reserved u32                    |
 * | 缺测哨兵：level=INT16_MIN，其余数值字段=USHRT_MAX / 255 |
 * +---------------- trailer 12B ----------------+
 * | magic "HYDROEND" 8B | crc32 u32（覆盖 header+records）|
 *
 * flags 位定义：
 * - bit0：ts_epoch_s 为 UTC 秒（置 1）；否则为北京时间墙钟对应的“伪 UTC 秒”，
 *   即 epoch 值按 UTC+8 解释后才是真实本地墙钟，解析器需再做时区换算。
 */

import { crc32 } from '../util/hash.ts';

export const HYDROBIN_MAGIC = new TextEncoder().encode('HYDROBIN');
export const HYDROBIN_END_MAGIC = new TextEncoder().encode('HYDROEND');
export const HEADER_SIZE = 32;
export const RECORD_SIZE = 18;
export const TRAILER_SIZE = 12;

export const FLAG_UTC_EPOCH = 0x0001;

/** 各字段的缺测哨兵 */
export const SENTINEL_LEVEL = -32768;
export const SENTINEL_USHORT = 65535;
export const SENTINEL_U8 = 255;

export interface HydroHeader {
  version: number;
  flags: number;
  stationId: string;
  intervalMin: number;
  recordCount: number;
}

export interface HydroRecord {
  epochSeconds: number;
  levelCm: number;
  flowDLps: number;
  rain10um: number;
  voltageDV: number;
  qc: number;
}

function writeAscii(dv: DataView, offset: number, text: string, len: number): void {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < len; i++) {
    dv.setUint8(offset + i, i < bytes.length ? bytes[i] : 0);
  }
}

export function readAscii(bytes: Uint8Array, offset: number, len: number): string {
  let end = offset;
  const limit = offset + len;
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder('ascii').decode(bytes.subarray(offset, end));
}

export function encodeHeader(h: HydroHeader): Uint8Array {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set(HYDROBIN_MAGIC, 0);
  dv.setUint16(8, h.version, true);
  dv.setUint16(10, h.flags, true);
  writeAscii(dv, 12, h.stationId, 8);
  dv.setUint16(20, h.intervalMin, true);
  dv.setUint32(22, h.recordCount, true);
  // 26..34 保留区（header 总长 32，保留 6 字节）保持 0
  return u8;
}

export function decodeHeader(bytes: Uint8Array): HydroHeader | string {
  if (bytes.length < HEADER_SIZE) return '文件截断：不足 32 字节文件头';
  for (let i = 0; i < HYDROBIN_MAGIC.length; i++) {
    if (bytes[i] !== HYDROBIN_MAGIC[i]) return '魔数不匹配，不是 HYDROBIN 文件';
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(8, true);
  if (version !== 1) return `不支持的版本号: ${version}`;
  return {
    version,
    flags: dv.getUint16(10, true),
    stationId: readAscii(bytes, 12, 8),
    intervalMin: dv.getUint16(20, true),
    recordCount: dv.getUint32(22, true),
  };
}

export function encodeRecord(r: HydroRecord): Uint8Array {
  const buf = new ArrayBuffer(RECORD_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, r.epochSeconds, true);
  dv.setInt16(4, r.levelCm, true);
  dv.setUint16(6, r.flowDLps, true);
  dv.setUint16(8, r.rain10um, true);
  dv.setUint8(10, r.voltageDV);
  dv.setUint8(11, r.qc);
  // 12..18 保留
  return new Uint8Array(buf);
}

export function decodeRecord(bytes: Uint8Array, offset: number): HydroRecord {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_SIZE);
  return {
    epochSeconds: dv.getUint32(0, true),
    levelCm: dv.getInt16(4, true),
    flowDLps: dv.getUint16(6, true),
    rain10um: dv.getUint16(8, true),
    voltageDV: dv.getUint8(10),
    qc: dv.getUint8(11),
  };
}

export function encodeTrailer(crc: number): Uint8Array {
  const buf = new ArrayBuffer(TRAILER_SIZE);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set(HYDROBIN_END_MAGIC, 0);
  dv.setUint32(8, crc >>> 0, true);
  return u8;
}

export interface TrailerCheck {
  /** null = 校验通过；否则为致命错误描述 */
  error: string | null;
  /** 记录区实际可读出的完整记录条数（可能小于 header 声明值，即尾部截断） */
  actualRecordCount: number;
  truncated: boolean;
}

/**
 * 校验文件尾。trailer 固定为文件最后 12 字节，因此即使记录区被截断也能定位。
 * - trailer 丢失/魔数错 -> 致命错误；
 * - CRC（覆盖 header + 实际存在的记录区）不匹配 -> 致命错误；
 * - 校验通过但实际条数 < header 声明数 -> 非致命截断，交由解析器部分入库。
 */
export function verifyTrailer(bytes: Uint8Array, header: HydroHeader): TrailerCheck {
  if (bytes.length < HEADER_SIZE + TRAILER_SIZE) {
    return { error: `文件截断：总长 ${bytes.length} 字节，连文件头+文件尾都不完整`, actualRecordCount: 0, truncated: true };
  }
  const trailerOff = bytes.length - TRAILER_SIZE;
  for (let i = 0; i < HYDROBIN_END_MAGIC.length; i++) {
    if (bytes[trailerOff + i] !== HYDROBIN_END_MAGIC[i]) {
      return { error: '文件尾魔数不匹配，文件可能被截断或损坏', actualRecordCount: 0, truncated: true };
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const storedCrc = dv.getUint32(trailerOff + 8, true);
  const actual = crc32(bytes.subarray(0, trailerOff));
  if (storedCrc !== actual) {
    return {
      error: `CRC32 校验失败：文件记录 0x${storedCrc.toString(16)}，实算 0x${actual.toString(16)}`,
      actualRecordCount: 0, truncated: false,
    };
  }

  const bodyBytes = trailerOff - HEADER_SIZE;
  const actualRecordCount = Math.floor(bodyBytes / RECORD_SIZE);
  const truncated = actualRecordCount < header.recordCount || bodyBytes % RECORD_SIZE !== 0;
  return { error: null, actualRecordCount, truncated };
}
