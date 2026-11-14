/**
 * DuckDB-WASM 连接管理。
 *
 * 浏览器：优先 eh（异常处理）构建，失败降级 mvp；两者都不需要 COOP/COEP 头，
 *         部署到任意静态服务器即可。wasm 用 ?url、worker 用 ?worker 交给 Vite 打包。
 * Node（vitest / 脚本）：走 node-worker 构建，SQL 层逻辑与浏览器完全一致。
 *
 * 持久化取舍：默认内存库 + 手动 JSON 导出/导入（见 backup.ts）。
 * 原因：OPFS 在 Safari 与 file:// 下支持不一致，内存库行为最可预测；
 * 数据量（20 站 × 5 分钟粒度 ≈ 210 万行/年）对 DuckDB 列存压力很小。
 */
import * as duckdb from '@duckdb/duckdb-wasm';

let singleton: duckdb.AsyncDuckDB | null = null;

async function createBrowser(): Promise<duckdb.AsyncDuckDB> {
  const ehWasm = (await import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url')).default;
  const mvpWasm = (await import('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url')).default;
  const EhWorker = (await import('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?worker')).default;
  const MvpWorker = (await import('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?worker')).default;

  const bundles = {
    eh: {
      mainModule: ehWasm,
      mainWorker: new EhWorker().toString(),
    },
    mvp: {
      mainModule: mvpWasm,
      mainWorker: new MvpWorker().toString(),
    },
  };

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const worker = new EhWorker();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundles.eh.mainModule);
  return db;
}

async function createNode(): Promise<duckdb.AsyncDuckDB> {
  const [{ createRequire }, path] = await Promise.all([
    import('node:module'),
    import('node:path'),
  ]);
  const require = createRequire(import.meta.url);
  // 该包的 exports 不暴露 package.json，只能解析主入口后回推 dist 目录
  const entry = require.resolve('@duckdb/duckdb-wasm');
  const dist = entry.slice(0, entry.lastIndexOf('/') + 1);
  const nodeApi = require('@duckdb/duckdb-wasm/dist/duckdb-node') as typeof duckdb;
  const bundles = {
    mvp: {
      mainModule: path.join(dist, 'duckdb-mvp.wasm'),
      mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs'),
    },
    eh: {
      mainModule: path.join(dist, 'duckdb-eh.wasm'),
      mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs'),
    },
  };
  const selected = await nodeApi.selectBundle(bundles);
  // 直接用 worker_threads 起 duckdb 的 node worker，再包成 duckdb-wasm 期望的
  // Web Worker 事件接口。绕开官方 createWorker（内部 fetch(file://) 在 Node 26
  // 的 undici 上尚未实现）。worker 内 emscripten 用 fs 按绝对路径加载 wasm。
  const { Worker } = await import('node:worker_threads');
  // duckdb worker 脚本按 Web Worker 约定用 globalThis.onmessage/postMessage，
  // 而 worker_threads 走 parentPort；用 eval 入口先做双向桥接再 require 真正脚本。
  const bootstrap = `
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = (m) => parentPort.postMessage(m);
    parentPort.on('message', (m) => {
      if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data: m });
    });
    require(${JSON.stringify(selected.mainWorker as string)});
  `;
  const nodeWorker = new Worker(bootstrap, { eval: true });
  const worker = adaptNodeWorker(nodeWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(selected.mainModule, selected.pthreadWorker);
  return db;
}

/** 把 worker_threads.Worker 适配成 duckdb-wasm 需要的 Web Worker 子集。 */
function adaptNodeWorker(nodeWorker: import('node:worker_threads').Worker): Worker {
  const target = new EventTarget() as unknown as Worker & {
    postMessage: (m: unknown) => void;
    terminate: () => void;
  };
  nodeWorker.on('message', (data) => {
    target.dispatchEvent(new MessageEvent('message', { data }));
  });
  nodeWorker.on('error', (err) => {
    target.dispatchEvent(new ErrorEvent('error', { error: err, message: (err as Error).message }));
  });
  nodeWorker.on('exit', (code) => {
    if (code !== 0) target.dispatchEvent(new ErrorEvent('error', { message: `worker 异常退出 code=${code}` }));
    target.dispatchEvent(new Event('close'));
  });
  target.postMessage = (m: unknown) => void nodeWorker.postMessage(m);
  target.terminate = () => void nodeWorker.terminate();
  return target as unknown as Worker;
}

export async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (singleton) return singleton;
  singleton = typeof window === 'undefined' ? await createNode() : await createBrowser();
  return singleton;
}

/** 仅供测试：关闭并清空单例。 */
export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.terminate();
    singleton = null;
  }
}

export async function withConn<T>(fn: (conn: duckdb.AsyncDuckDBConnection) => Promise<T>): Promise<T> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

/**
 * 统一 SQL 执行入口。
 * duckdb-wasm 的 conn.query() 不接受绑定参数，参数化语句必须 prepare 后 run；
 * 无参数语句直接 query，省一次 prepare 往返。
 */
export async function sql(
  conn: duckdb.AsyncDuckDBConnection,
  text: string,
  params: unknown[] = [],
): Promise<{ numRows: number; toArray: () => Record<string, unknown>[] }> {
  if (params.length === 0) {
    const table = await conn.query(text);
    return {
      numRows: table.numRows,
      toArray: () => table.toArray() as unknown as Record<string, unknown>[],
    };
  }
  const prepared = await conn.prepare(text);
  try {
    const table = await prepared.query(...params);
    return {
      numRows: table.numRows,
      toArray: () => table.toArray() as unknown as Record<string, unknown>[],
    };
  } finally {
    await prepared.close();
  }
}

export type SqlRunner = (text: string, params?: unknown[]) => Promise<{
  numRows: number;
  toArray: () => Record<string, unknown>[];
}>;

/**
 * 列存批量加载器：把一批同构行经 Apache Arrow IPC 流一次性写入临时表。
 * 整条文件只需一次写入往返，替代逐行 INSERT——后者会产生数十万 Arrow 结果
 * 对象撑爆 wasm 3.1GB 堆。
 *
 * 为什么不用 insertJSONFromPath：当前 duckdb-wasm 的 column-object JSON 读取在
 * 多列混合类型下存在按位置错位的 bug；Arrow IPC 按列名对齐，可靠无误。
 *
 * 类型策略：临时表统一建为 VARCHAR，Arrow 只负责把字符串/null 可靠送达
 * （tableFromArrays 对纯字符串列推断稳定），所有数值/时间转换下推到写入
 * 目标表时的 SQL CAST，避开 Arrow 对整数/字符串的自动类型推断差异。
 *
 * @param ddl 建临时表的 CREATE 语句（表名需与 tableName 一致，列应为 VARCHAR）
 * @param columnOrder 列名顺序
 * @param columns 列名 -> 该列所有行的值数组
 */
export async function loadTempTable(
  conn: duckdb.AsyncDuckDBConnection,
  _db: duckdb.AsyncDuckDB,
  tableName: string,
  ddl: string,
  columnOrder: string[],
  columns: Record<string, unknown[]>,
): Promise<void> {
  const arrow = await import('apache-arrow');
  await conn.query(`DROP TABLE IF EXISTS ${tableName}`);
  await conn.query(ddl);
  const totalRows = Math.max(0, ...Object.values(columns).map((a) => a.length));
  if (totalRows === 0) return;

  // 全部转成字符串数组（null 保留），保证 Arrow 列类型一致、按列名对齐
  const arrays: Record<string, (string | null)[]> = {};
  for (const name of columnOrder) {
    arrays[name] = (columns[name] ?? []).map((v) => (v === null || v === undefined ? null : String(v)));
  }
  const table = arrow.tableFromArrays(arrays);
  const ipc = arrow.tableToIPC(table, 'stream');
  await conn.insertArrowFromIPCStream(ipc, { name: tableName, create: false });
}
