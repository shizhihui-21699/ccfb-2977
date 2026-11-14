/** 应用入口：导航路由、启动初始化、快照导入导出。 */
import './styles.css';
import { h, toast, download, clear } from './dom.ts';
import { seedMetadata } from '../db/metadata.ts';
import { exportSnapshot, importSnapshot } from '../db/backup.ts';
import { renderDataSources } from './page-sources.ts';
import { renderImport } from './page-import.ts';
import { renderQc } from './page-qc.ts';
import { renderMetrics } from './page-metrics.ts';
import { renderLineage } from './page-lineage.ts';

type PageId = 'sources' | 'import' | 'qc' | 'metrics' | 'lineage';

const PAGES: { id: PageId; label: string; icon: string; title: string }[] = [
  { id: 'sources', label: '数据源', icon: '▤', title: '数据源与字段映射' },
  { id: 'import', label: '导入批次', icon: '⇪', title: '导入批次' },
  { id: 'qc', label: '质控', icon: '✓', title: '数据质控' },
  { id: 'metrics', label: '指标', icon: '∑', title: '指标服务（DWS）' },
  { id: 'lineage', label: '数据血缘', icon: '⤓', title: '数据血缘' },
];

const RENDERERS: Record<PageId, (body: HTMLElement, actions: HTMLElement) => Promise<void>> = {
  sources: (b) => renderDataSources(b),
  import: (b, a) => renderImport(b, a),
  qc: (b, a) => renderQc(b, a),
  metrics: (b, a) => renderMetrics(b, a),
  lineage: (b, a) => renderLineage(b, a),
};

let current: PageId = 'sources';

async function navigate(id: PageId): Promise<void> {
  current = id;
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.page === id));
  const meta = PAGES.find((p) => p.id === id)!;
  document.getElementById('page-title')!.textContent = meta.title;
  const body = document.getElementById('page-body')!;
  const actions = document.getElementById('page-actions')!;
  clear(actions);
  body.replaceChildren(h('div', { class: 'empty' }, '加载中…'));
  try {
    await RENDERERS[id](body, actions);
  } catch (err) {
    body.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, '页面加载失败'),
      h('pre', { class: 'mono', style: 'color:#dc2626;white-space:pre-wrap' }, (err as Error).message),
    ));
  }
}

function buildNav(): void {
  const nav = document.getElementById('nav')!;
  nav.replaceChildren(...PAGES.map((p) =>
    h('button', {
      class: `nav-item ${p.id === current ? 'active' : ''}`,
      dataset: { page: p.id },
      onclick: () => void navigate(p.id),
    }, h('span', { class: 'nav-icon' }, p.icon), p.label),
  ));
}

async function boot(): Promise<void> {
  buildNav();
  try {
    await seedMetadata();
  } catch (err) {
    toast(`初始化失败：${(err as Error).message}`, 'err', 10000);
  }
  await navigate('sources');

  document.getElementById('btn-export')!.addEventListener('click', async () => {
    const snap = await exportSnapshot();
    download(`hydro-snapshot-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(snap));
    toast('快照已导出', 'ok');
  });

  document.getElementById('file-snapshot')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const snap = JSON.parse(await file.text());
      await importSnapshot(snap);
      toast('快照已导入，页面将刷新', 'ok');
      setTimeout(() => void navigate(current), 300);
    } catch (err) {
      toast(`快照导入失败：${(err as Error).message}`, 'err', 8000);
    } finally {
      input.value = '';
    }
  });
}

void boot();
