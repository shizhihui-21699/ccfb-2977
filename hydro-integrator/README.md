# 水文数据整合平台（hydro-integrator）

纯浏览器运行的多厂家水文记录仪数据整合工具。底层为 DuckDB-WASM，按
**ODS / DWD / DWS** 三层组织数据，覆盖解析、字段映射、幂等导入、增量合并、
质控、指标与端到端数据血缘。无后端、无网络上报，数据只落在浏览器内存，
可随时导出 JSON 快照归档。

## 快速开始

```bash
npm install
npm run gen:data     # 生成三厂家测试数据到 testdata/（86 个文件，含各类异常）
npm run dev          # 启动 http://localhost:5173
```

测试：

```bash
npm test             # 39 个单元 + 集成测试（Node 内真实跑 DuckDB-WASM）
npm run test:e2e     # Playwright 浏览器端到端冒烟（需先 npm run dev 或自动拉起）
npm run build        # 类型检查 + 生产构建到 dist/
```

## 三个厂家与三种格式

| 厂家 | 格式 | 时间语义 | 解析器 |
| --- | --- | --- | --- |
| 清河仪器 | CSV，中文表头 | 北京时间墙钟（Asia/Shanghai） | `src/parsers/csv-qinghe.ts` |
| 远山测控 | 定宽文本，无表头，缺测带哨兵 | UTC ISO | `src/parsers/fixedwidth-yuanshan.ts` |
| 蓝石电子 | HYDROBIN 二进制，CRC32 校验 | header flags 区分 UTC / 北京伪 epoch | `src/parsers/binary-lanshi.ts` |

二进制格式定义见 `src/parsers/binary-codec.ts`，造数脚本与解析器共用同一套常量。

## 分层模型

- **ODS `ods_raw_record`**：原始字段逐行留存（JSON），只追加、不更新、不删除，
  是血缘的最终事实来源。
- **DWD `dwd_water_record`**：统一宽表，时间一律转 UTC（`TIMESTAMP WITH TIME ZONE`），
  按 `(station_code, ts_utc)` 幂等。`dwd_record_lineage` 记录宽表行与 ODS 行的
  多对多血缘，补传覆盖时旧来源置 `is_current=false` 但不删除。
- **DWS `dws_daily` / `dws_monthly`**：物化的日均水位、月极值（含发生时刻）、
  超警戒时长。

## 关键设计取舍

### 幂等与增量合并（三道防线）

1. **文件级**：`batch_file.file_hash` 去重，同一文件再传直接 `duplicate_skipped`；
2. **记录级**：`ods_raw_record.record_hash` 唯一索引（文件哈希 + 行号 + 规范化内容），
   文件改名后重传，内容相同的行依然被拒；
3. **宽表级**：DWD 按 `(站, 时刻)` UPSERT，补传的同刻新值覆盖旧值，行数不增，
   旧来源在血缘表保留为历史版本。

### 时间与夏令时

`src/util/time.ts` 不依赖第三方时区库，基于 `Intl.DateTimeFormat` 取任意 IANA
时区的偏移，用「候选 UTC 瞬间回查偏移是否自洽」严格区分正常、fold（回退重复时刻）、
gap（跳时间隙）。fold 按记录出现次序 `occurrence` 消歧，gap 前调到过渡后并告警。
中国站全年 +8 无 DST，海外站（造数含 America/New_York 样本）同样可处理。

### 批量写入与 wasm 内存

逐行 `prepare` 会在 3.1GB 的 wasm 堆上累积数十万 Arrow 对象导致 OOM。导入改为
**每文件一次 Apache Arrow IPC 批量写入**临时表（`loadTempTable`），再用集合 SQL
完成 ODS 去重、DWD UPSERT、血缘登记。途中发现 duckdb-wasm 的 column-object JSON
读取在多列混合类型下会错位，故选择强类型、按列名对齐的 Arrow IPC 路径。

### Node 测试环境适配

duckdb-wasm 官方 `createWorker` 内部走 `fetch(file://)`，而 Node 的 undici 尚未
实现 file scheme。`src/db/connection.ts` 在 Node 下直接用 `worker_threads` 起
worker，并用一段 bootstrap 桥接 `parentPort` 与 Web Worker 风格的
`onmessage/postMessage`；浏览器仍走标准 Vite `?worker` 打包。

### 持久化

默认内存库 + 手动 JSON 快照（`src/db/backup.ts`）。OPFS 在 Safari 与 file:// 下
支持不一致，内存库 + 快照更贴合「月度拼表后归档一份」的运维形态，也便于跨机器迁移。

## 质控规则

`src/qc/engine.ts` 实现四类自动规则，参数在界面可调、存 `qc_rule_config`：

- 超量程（水位/流量/电压）
- 跳变（与相邻有效采样比较，跨缺测缺口不参与，避免误判）
- 长时间不变（连续 N 个有效水位完全相同）
- 缺测（按站点期望间隔检测超容忍窗口的缺口）

重跑自动规则只清 `source='auto'` 标记，人工标记（`source='manual'`）与复核状态保留。

## 测试数据异常覆盖

`testdata/` 内每个厂家都有几十个文件，故意植入：截断记录、坏时间戳、CRC32 校验
失败、CRC 自洽但记录区短少、补传覆盖、DST fold、随机缺测/跳变/冻结/超量程。
