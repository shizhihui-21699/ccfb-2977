/** 导入批次页：选择数据源 → 多文件导入 → 批次历史与文件级明细/异常查看。 */
import type { DataSource } from '../types.ts';
import { importFiles } from '../db/import-service.ts';
import { listBatches, listDataSources, listMappings } from '../db/queries.ts';
import { getBatchDetail } from '../db/queries.ts';
import { badge, clear, h, modal, toast } from './dom.ts';

let selectedDsId = 1;

export async function renderImport(body: HTMLElement, actions: HTMLElement): Promise<void> {
  const sources = await listDataSources();
  clear(body);
  clear(actions);

  const dsSelect = h('select', {},
    ...sources.map((s) => h('option', { value: String(s.id) }, `${s.vendor}（${s.format}）`)),
  );
  dsSelect.value = String(selectedDsId);
  dsSelect.addEventListener('change', () => { selectedDsId = Number(dsSelect.value); });
  actions.append(h('label', { class: 'btn btn-primary' }, '选择文件导入',
    h('input', {
      type: 'file', multiple: 'true', hidden: 'hidden',
      onchange: (e: Event) => {
        const input = e.target as HTMLInputElement;
        if (input.files) void handleFiles(input.files, sources);
      },
    }),
  ));

  const zone = h('div', { class: 'drop-zone card' },
    h('div', { style: 'font-size:15px;margin-bottom:8px' }, h('strong', {}, '点击或拖拽文件到此处导入')),
    h('div', {}, '支持 CSV / 定宽 TXT / HYDROBIN 二进制；同一文件重复导入自动跳过，补传旧数据增量合并'),
  );
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (e.dataTransfer?.files) void handleFiles(e.dataTransfer.files, sources);
  });
  zone.addEventListener('click', () => {
    const pick = h('input', { type: 'file', multiple: 'true' });
    pick.addEventListener('change', () => pick.files && handleFiles(pick.files, sources));
    pick.click();
  });

  const dsBox = h('div', { class: 'card' },
    h('h2', {}, '当前数据源'),
    h('div', { class: 'flex' }, h('span', { class: 'muted' }, '导入到：'), dsSelect),
  );

  const listBox = h('div', { class: 'card' }, h('h2', {}, '批次历史'), h('div', { id: 'batch-list' }, '加载中…'));

  body.append(dsBox, zone, listBox);
  await refreshBatchList();
}

async function handleFiles(fileList: FileList, sources: DataSource[]): Promise<void> {
  const files = Array.from(fileList);
  if (files.length === 0) return;
  const inputs = await Promise.all(files.map(async (f) => ({
    fileName: f.name,
    bytes: new Uint8Array(await f.arrayBuffer()),
    dataSourceId: selectedDsId,
  })));
  const allMappings = await listMappings();
  const mapByDs = new Map(sources.map((s) => [s.id, allMappings.filter((m) => m.dataSourceId === s.id)]));
  try {
    toast(`正在导入 ${files.length} 个文件…`, 'info', 60000);
    const outcome = await importFiles(inputs, sources, mapByDs, `界面导入 ${files.length} 文件`);
    const b = outcome.batch;
    toast(`导入完成：新增 ${b.recordCount} 行，重复文件 ${b.duplicateFileCount}，`
      + `重复行 ${b.duplicateRowCount}，补传覆盖 ${b.supersededCount}，异常 ${b.issueCount}`, 'ok', 6000);
    const body = document.getElementById('page-body')!;
    await refreshBatchList();
    void body;
  } catch (err) {
    toast(`导入失败：${(err as Error).message}`, 'err', 8000);
  }
}

async function refreshBatchList(): Promise<void> {
  const box = document.getElementById('batch-list');
  if (!box) return;
  const batches = await listBatches();
  if (batches.length === 0) {
    box.replaceChildren(h('div', { class: 'empty' }, '尚无导入批次'));
    return;
  }
  const statusTone = (s: string) => (s === 'completed' ? 'ok' : s === 'partial' ? 'warn' : 'err');
  box.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '批次号'), h('th', {}, '时间'), h('th', {}, '状态'),
      h('th', { class: 'num' }, '文件'), h('th', { class: 'num' }, '新增行'),
      h('th', { class: 'num' }, '重复文件'), h('th', { class: 'num' }, '重复行'),
      h('th', { class: 'num' }, '补传覆盖'), h('th', { class: 'num' }, '异常'), h('th', {}, ''),
    )),
    h('tbody', {}, ...batches.map((b) => h('tr', {},
      h('td', { class: 'mono' }, b.batchNo),
      h('td', {}, new Date(b.importedAt).toLocaleString('zh-CN')),
      h('td', {}, badge(b.status, statusTone(b.status))),
      h('td', { class: 'num' }, String(b.fileCount)),
      h('td', { class: 'num' }, String(b.recordCount)),
      h('td', { class: 'num' }, String(b.duplicateFileCount)),
      h('td', { class: 'num' }, String(b.duplicateRowCount)),
      h('td', { class: 'num' }, String(b.supersededCount)),
      h('td', { class: 'num' }, String(b.issueCount)),
      h('td', {}, h('button', {
        class: 'btn btn-sm',
        onclick: () => void openBatch(b.id),
      }, '明细')),
    ))),
  )));
}

async function openBatch(batchId: number): Promise<void> {
  const detail = await getBatchDetail(batchId);
  if (!detail) return;
  const fileTone = (s: string) =>
    (s === 'imported' ? 'ok' : s === 'duplicate_skipped' ? 'muted' : 'err');
  const bodyEl = h('div', {},
    h('div', { class: 'stat-grid', style: 'margin-bottom:16px' },
      stat('新增行', detail.recordCount), stat('重复文件', detail.duplicateFileCount),
      stat('重复行', detail.duplicateRowCount), stat('补传覆盖', detail.supersededCount),
      stat('异常数', detail.issueCount),
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '文件名'), h('th', {}, '状态'),
        h('th', { class: 'num' }, '入库行'), h('th', {}, '致命错误'),
      )),
      h('tbody', {}, ...detail.files.map((f) => h('tr', {},
        h('td', { class: 'mono' }, f.fileName),
        h('td', {}, badge(f.status, fileTone(f.status))),
        h('td', { class: 'num' }, String(f.recordCount)),
        h('td', { class: 'muted' }, f.fatalError ?? '—'),
      ))),
    )),
  );
  modal(`批次 ${detail.batchNo}`, bodyEl);
}

function stat(label: string, value: number): HTMLElement {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, String(value)),
  );
}
