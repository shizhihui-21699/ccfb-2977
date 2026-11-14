import type { ParsedFile } from '../types.ts';

/** 所有厂家解析器的统一接口：输入文件名+字节，输出规范化的 ParsedFile。 */
export interface FileParser {
  readonly format: ParsedFile['format'];
  parse(fileName: string, bytes: Uint8Array, dataSourceId: number): Promise<ParsedFile>;
}

/** 去掉 UTF-8 BOM 与行尾 \r。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 简易 CSV 行切分：支持双引号包裹与引号内逗号（本项目数据不含引号内换行）。 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
