/**
 * 哈希与校验和工具。
 * - SHA-256：文件级去重与记录级幂等键（record_hash）
 * - CRC32：蓝石厂家二进制格式的文件尾校验
 * 浏览器走 SubtleCrypto，Node（测试/脚本）走 node:crypto，接口保持一致。
 */

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 与 zlib.crc32 / PKZIP 一致的 CRC32，返回无符号 32 位整数。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let nodeCrypto: typeof import('node:crypto') | null | undefined;

async function sha256Bytes(data: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (nodeCrypto === undefined) {
    try {
      nodeCrypto = await import('node:crypto');
    } catch {
      nodeCrypto = null;
    }
  }
  if (nodeCrypto) {
    return nodeCrypto.createHash('sha256').update(data).digest('hex');
  }
  throw new Error('当前环境不支持 SHA-256（既无 WebCrypto 也无 node:crypto）');
}

export async function sha256File(bytes: Uint8Array): Promise<string> {
  return sha256Bytes(bytes);
}

/**
 * 记录级幂等哈希：同一文件同一行同一内容永远得到相同 hash。
 * 参与哈希的字段全部取自 ODS 原始值，避免映射调整后历史行无法去重。
 */
export async function recordHash(fileHash: string, sourceLine: number, canonical: string): Promise<string> {
  const payload = `${fileHash}|${sourceLine}|${canonical}`;
  const bytes = new TextEncoder().encode(payload);
  return sha256Bytes(bytes);
}

/** 同步版 recordHash 的备选实现入口（当前未使用，保留给 Worker 内批处理）。 */
export function stableStringify(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort();
  return keys.map((k) => `${k}=${fields[k] === null ? '∅' : String(fields[k])}`).join(';');
}
