/**
 * 领域类型定义。
 *
 * 数据分层：
 * - ODS：原始记录层（ods_raw_record），逐行保存解析出的原始字段与文件溯源信息
 * - DWD：明细宽表层（dwd_water_record），统一字段、统一 UTC 时间、去重、质控标记
 * - DWS：服务指标层（dws_daily / dws_monthly），日均、月极值、超警戒时长
 */

/** 三个厂家的文件格式 */
export type FileFormat = 'csv_qinghe' | 'fixedwidth_yuanshan' | 'binary_lanshi';

/** 原始文件里时间戳的归属方式 */
export type TimeZoneMode = 'Asia/Shanghai' | 'UTC' | 'manual';

export interface DataSource {
  id: number;
  /** 厂家名称，如 清河仪器 */
  vendor: string;
  format: FileFormat;
  /** 该厂家文件中时间戳的默认时区 */
  tzMode: TimeZoneMode;
  /** tzMode = manual 时使用的 IANA 时区名 */
  manualTz?: string;
  description: string;
  enabled: boolean;
  createdAt: string;
}

/** 字段映射：源字段名 -> 宽表标准字段 */
export interface FieldMapping {
  id: number;
  dataSourceId: number;
  sourceField: string;
  /** 目标标准字段；null 表示该源字段不入库（忽略） */
  targetField: CanonicalField | null;
  /** 数值类字段的线性换算系数：标准值 = (原始值 + offset) * scale */
  scale: number;
  offset: number;
  /** 界面上是否允许再编辑 */
  builtin: boolean;
}

export type CanonicalField =
  | 'station_code'
  | 'ts_utc'
  | 'water_level_m'
  | 'flow_m3s'
  | 'rainfall_mm'
  | 'voltage_v'
  | 'quality_code';

/** 解析器产出的单条原始记录（未经映射、未转时区） */
export interface RawRecord {
  /** 文件内行号，从 1 开始（二进制文件按记录序号） */
  sourceLine: number;
  /** 原始字段键值对，键为厂家各自的字段名 */
  fields: Record<string, string | number | null>;
  /** 原始时间戳字符串/数字，原样保留用于溯源 */
  rawTimestamp: string;
  /**
   * 重复时刻消歧标记：同一本地墙钟时间在文件中第几次出现（0 起）。
   * 仅在 DST 回退导致的重复时刻场景下可能 > 0。
   */
  occurrence: number;
}

export interface ParseIssue {
  sourceLine: number;
  level: 'warn' | 'error';
  code:
    | 'TRUNCATED_RECORD'
    | 'CHECKSUM_MISMATCH'
    | 'BAD_TIMESTAMP'
    | 'BAD_NUMBER'
    | 'DST_GAP_ADJUSTED'
    | 'DST_FOLD'
    | 'UNMAPPED_FIELD'
    | 'UNKNOWN_STATION';
  message: string;
}

export interface ParsedFile {
  fileName: string;
  dataSourceId: number;
  format: FileFormat;
  /** 整个文件内容的 SHA-256，用于批次级去重 */
  fileHash: string;
  records: RawRecord[];
  issues: ParseIssue[];
  /** 文件级致命错误（如魔数不对、整体截断），有值时该文件不入 ODS */
  fatalError?: string;
  /** 解析耗时（毫秒），便于界面展示 */
  parseMs: number;
}

export interface ImportBatch {
  id: number;
  batchNo: string;
  importedAt: string;
  fileCount: number;
  recordCount: number;
  /** 因文件哈希重复被整体跳过的文件数 */
  duplicateFileCount: number;
  /** 因 record_hash 命中而跳过的行数 */
  duplicateRowCount: number;
  /** 补传合并时覆盖更新的行数 */
  supersededCount: number;
  issueCount: number;
  status: 'completed' | 'partial' | 'failed';
  note: string;
}

export interface BatchFile {
  id: number;
  batchId: number;
  fileName: string;
  fileHash: string;
  dataSourceId: number;
  recordCount: number;
  status: 'imported' | 'duplicate_skipped' | 'rejected';
  fatalError: string | null;
}

/** 质控标记类别 */
export type QcFlagType = 'jump' | 'range' | 'frozen' | 'missing' | 'manual';

export type QcSeverity = 'ok' | 'warning' | 'error';

export interface QcRuleConfig {
  /** 相邻采样间隔（分钟），用于缺测判定 */
  expectedIntervalMin: number;
  /** 连续多少个间隔缺测算缺测标记（缺测窗口） */
  missingToleranceIntervals: number;
  /** 水位跳变阈值（米/相邻间隔） */
  jumpThresholdM: number;
  /** 水位量程 [min, max]（米） */
  levelRange: [number, number];
  /** 流量量程 [min, max] */
  flowRange: [number, number];
  /** 电压量程 [min, max] */
  voltageRange: [number, number];
  /** 连续 N 个采样值完全不变判为冻结 */
  frozenCount: number;
  /** 警戒水位（米），用于超警戒时长指标 */
  warningLevelM: number;
}

export interface QcFlag {
  id: number;
  stationCode: string;
  tsUtc: string;
  flagType: QcFlagType;
  severity: QcSeverity;
  /** auto = 规则引擎生成；manual = 人工标记 */
  source: 'auto' | 'manual';
  message: string;
  /** 人工复核状态 */
  reviewStatus: 'open' | 'confirmed' | 'cleared';
  reviewer: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** 数据血缘查询结果中的一行 */
export interface LineageEdge {
  layer: 'DWS' | 'DWD' | 'ODS';
  tableName: string;
  stationCode: string;
  tsUtc: string;
  fileName: string;
  sourceLine: number | null;
  detail: string;
}
