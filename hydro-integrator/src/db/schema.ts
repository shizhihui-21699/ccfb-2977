/**
 * 数据库 Schema（DDL 集中管理）。
 *
 * 分层：
 *   元数据：data_source / field_mapping / station_config / import_batch / batch_file
 *   ODS ：ods_raw_record    原始字段逐行留存（JSON），永不更新，只追加
 *   DWD ：dwd_water_record  统一宽表，UTC 时间，按 (站, 时刻) 幂等 UPSERT
 *         dwd_record_lineage 宽表行与 ODS 行的多对多血缘（补传覆盖时保留历史来源）
 *   DWS ：dws_daily / dws_monthly  指标服务层
 *   质控：qc_flag / qc_rule_config
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS data_source (
  id INTEGER PRIMARY KEY,
  vendor VARCHAR NOT NULL,
  format VARCHAR NOT NULL,
  tz_mode VARCHAR NOT NULL,
  manual_tz VARCHAR,
  description VARCHAR,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_mapping (
  id INTEGER PRIMARY KEY,
  data_source_id INTEGER NOT NULL REFERENCES data_source(id),
  source_field VARCHAR NOT NULL,
  target_field VARCHAR,
  scale DOUBLE NOT NULL DEFAULT 1,
  "offset" DOUBLE NOT NULL DEFAULT 0,
  builtin BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (data_source_id, source_field)
);

CREATE SEQUENCE IF NOT EXISTS seq_field_mapping START 1000;

CREATE TABLE IF NOT EXISTS station_config (
  station_code VARCHAR PRIMARY KEY,
  station_name VARCHAR,
  warning_level_m DOUBLE NOT NULL DEFAULT 20.0,
  expected_interval_min INTEGER NOT NULL DEFAULT 60,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE SEQUENCE IF NOT EXISTS seq_import_batch START 1;
CREATE TABLE IF NOT EXISTS import_batch (
  id INTEGER PRIMARY KEY DEFAULT nextval('seq_import_batch'),
  batch_no VARCHAR NOT NULL UNIQUE,
  imported_at TIMESTAMP NOT NULL DEFAULT now(),
  file_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  duplicate_file_count INTEGER NOT NULL DEFAULT 0,
  duplicate_row_count INTEGER NOT NULL DEFAULT 0,
  superseded_count INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR NOT NULL,
  note VARCHAR
);

CREATE TABLE IF NOT EXISTS batch_file (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  file_name VARCHAR NOT NULL,
  file_hash VARCHAR NOT NULL,
  data_source_id INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  status VARCHAR NOT NULL,
  fatal_error VARCHAR
);

CREATE SEQUENCE IF NOT EXISTS seq_batch_file START 1;

CREATE TABLE IF NOT EXISTS ods_raw_record (
  id BIGINT PRIMARY KEY,
  batch_id INTEGER NOT NULL,
  file_name VARCHAR NOT NULL,
  file_hash VARCHAR NOT NULL,
  data_source_id INTEGER NOT NULL,
  source_line INTEGER NOT NULL,
  raw_timestamp VARCHAR,
  raw_fields JSON NOT NULL,
  record_hash VARCHAR NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS seq_ods START 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ods_record_hash ON ods_raw_record(record_hash);
CREATE INDEX IF NOT EXISTS ix_ods_file ON ods_raw_record(file_hash, source_line);

CREATE TABLE IF NOT EXISTS dwd_water_record (
  id BIGINT PRIMARY KEY,
  station_code VARCHAR NOT NULL,
  ts_utc TIMESTAMP WITH TIME ZONE NOT NULL,
  water_level_m DOUBLE,
  flow_m3s DOUBLE,
  rainfall_mm DOUBLE,
  voltage_v DOUBLE,
  quality_code INTEGER,
  record_hash VARCHAR NOT NULL,
  source_file_hash VARCHAR NOT NULL,
  source_file_name VARCHAR NOT NULL,
  source_line INTEGER NOT NULL,
  raw_timestamp VARCHAR,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (station_code, ts_utc)
);

CREATE SEQUENCE IF NOT EXISTS seq_dwd START 1;
CREATE INDEX IF NOT EXISTS ix_dwd_station_ts ON dwd_water_record(station_code, ts_utc);
CREATE INDEX IF NOT EXISTS ix_dwd_hash ON dwd_water_record(record_hash);

-- 血缘：同一 (站, 时刻) 每次被补传覆盖，都保留旧 ODS 行的关联，形成多版本链
CREATE TABLE IF NOT EXISTS dwd_record_lineage (
  station_code VARCHAR NOT NULL,
  ts_utc TIMESTAMP WITH TIME ZONE NOT NULL,
  ods_record_hash VARCHAR NOT NULL,
  file_name VARCHAR NOT NULL,
  source_line INTEGER NOT NULL,
  valid_from TIMESTAMP NOT NULL DEFAULT now(),
  superseded_at TIMESTAMP,
  is_current BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (station_code, ts_utc, ods_record_hash)
);

CREATE TABLE IF NOT EXISTS qc_rule_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  expected_interval_min INTEGER NOT NULL DEFAULT 60,
  missing_tolerance_intervals INTEGER NOT NULL DEFAULT 2,
  jump_threshold_m DOUBLE NOT NULL DEFAULT 1.5,
  level_min DOUBLE NOT NULL DEFAULT 0,
  level_max DOUBLE NOT NULL DEFAULT 50,
  flow_min DOUBLE NOT NULL DEFAULT 0,
  flow_max DOUBLE NOT NULL DEFAULT 500,
  voltage_min DOUBLE NOT NULL DEFAULT 9,
  voltage_max DOUBLE NOT NULL DEFAULT 16,
  frozen_count INTEGER NOT NULL DEFAULT 6,
  warning_level_m DOUBLE NOT NULL DEFAULT 20
);

INSERT INTO qc_rule_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS qc_flag (
  id BIGINT PRIMARY KEY,
  station_code VARCHAR NOT NULL,
  ts_utc TIMESTAMP WITH TIME ZONE NOT NULL,
  flag_type VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  message VARCHAR NOT NULL,
  review_status VARCHAR NOT NULL DEFAULT 'open',
  reviewer VARCHAR,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (station_code, ts_utc, flag_type, source)
);

CREATE SEQUENCE IF NOT EXISTS seq_qc START 1;
CREATE INDEX IF NOT EXISTS ix_qc_station_ts ON qc_flag(station_code, ts_utc);

CREATE TABLE IF NOT EXISTS dws_daily (
  station_code VARCHAR NOT NULL,
  stat_date DATE NOT NULL,
  avg_level_m DOUBLE,
  max_level_m DOUBLE,
  max_level_ts TIMESTAMP WITH TIME ZONE,
  min_level_m DOUBLE,
  min_level_ts TIMESTAMP WITH TIME ZONE,
  sample_count INTEGER NOT NULL,
  missing_count INTEGER NOT NULL,
  over_warning_minutes BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (station_code, stat_date)
);

CREATE TABLE IF NOT EXISTS dws_monthly (
  station_code VARCHAR NOT NULL,
  stat_month VARCHAR NOT NULL,
  max_level_m DOUBLE,
  max_level_ts TIMESTAMP WITH TIME ZONE,
  min_level_m DOUBLE,
  min_level_ts TIMESTAMP WITH TIME ZONE,
  avg_level_m DOUBLE,
  over_warning_minutes BIGINT NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (station_code, stat_month)
);
`;
