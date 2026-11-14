/** 数据血缘页：浏览 DWD 宽表，点任意一个采样点逐级追溯到 ODS 原始文件行。 */
import type { LineageEdge } from '../types.ts';
import { traceDailyMetric, traceDwdPoint } from '../lineage/lineage-service.ts';
import { browseDwd } from '../db/queries.ts';
import { listStations } from '../db/queries.ts';
import { badge, clear, fmtNum, h, modal, toast } from './dom.ts';

const LAYER_TONE: Record<LineageEdge['layer'], 'info' | 'err' | 'warn'> = {
  ODS: 'info', DWD: 'err', DWS: 'warn',
};

export async function renderLineage(body: HTMLElement, actions: HTMLElement): Promise<void> {
  clear(body);
  clear(actions);
  const stations = await listStations();

  const stationFilter = h('select', {},
    h('option', { value: '' }, '全部站点'),
    ...stations.map((s) => h('option', { value: String(s.stationCode) }, String(s.stationCode))),
  );
  const search = h('button', { class: 'btn btn-primary' }, '查询');
  actions.append(stationFilter, search);

  const hint = h('div', { class: 'card muted' },
    '点击下方任意采样行的「追溯」按钮，可看到该数值从 DWD 宽表到 ODS 原始记录的完整链路，'
    + '包括原始文件名、文件内行号、原始字段与原始时间戳；被补传覆盖的历史来源也会保留。');
  const listCard = h('div', { class: 'card' },
    h('h2', {}, 'DWD 宽表明细'),
    h('div', { id: 'dwd-list' }, '加载中…'),
  );
  body.append(hint, listCard);

  async function load(): Promise<void> {
    const { rows, total } = await browseDwd({
      station: stationFilter.value || undefined,
      limit: 200,
    });
    const box = document.getElementById('dwd-list')!;
    box.replaceChildren(
      h('p', { class: 'muted' }, `共 ${total} 行，显示最新 ${rows.length} 行`),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '站码'), h('th', {}, 'UTC 时间'),
          h('th', { class: 'num' }, '水位(m)'), h('th', { class: 'num' }, '流量'),
          h('th', { class: 'num' }, '降雨'), h('th', { class: 'num' }, '电压'),
          h('th', {}, '质控'), h('th', {}, '来源文件:行'), h('th', {}, ''),
        )),
        h('tbody', {}, ...rows.map((r) => h('tr', {},
          h('td', {}, r.stationCode),
          h('td', { class: 'mono' }, r.tsUtc.replace('T', ' ').replace('Z', '')),
          h('td', { class: 'num' }, fmtNum(r.waterLevelM)),
          h('td', { class: 'num' }, fmtNum(r.flowM3s)),
          h('td', { class: 'num' }, fmtNum(r.rainfallMm, 1)),
          h('td', { class: 'num' }, fmtNum(r.voltageV, 1)),
          h('td', {}, r.flags.length
            ? h('span', { class: 'pill-row' }, ...r.flags.map((f) => badge(f, 'warn')))
            : badge('正常', 'ok')),
          h('td', { class: 'mono muted' }, `${r.sourceFileName}:${r.sourceLine}`),
          h('td', {}, h('button', {
            class: 'btn btn-sm',
            onclick: () => void openLineage(r.stationCode, r.tsUtc),
          }, '追溯')),
        ))),
      )),
    );
  }

  search.addEventListener('click', () => void load());
  stationFilter.addEventListener('change', () => void load());
  await load();
}

/** 打开血缘弹窗。给定 tsUtc 走单点追溯；只给 statDate 走日指标下钻。 */
export async function openLineage(
  stationCode: string,
  tsUtc?: string,
  statDate?: string,
): Promise<void> {
  try {
    const result = tsUtc
      ? await traceDwdPoint(stationCode, tsUtc)
      : await traceDailyMetric(stationCode, statDate!);

    const nodes = result.edges.map((edge) => {
      const rawKey = `${edge.fileName}:${edge.sourceLine}`;
      const raw = result.rawDetails[rawKey];
      return h('div', { class: `lineage-node layer-${edge.layer}` },
        h('div', { class: 'flex' },
          badge(edge.layer, LAYER_TONE[edge.layer]),
          h('strong', {}, edge.tableName),
          h('span', { class: 'spacer' }),
          edge.sourceLine ? h('span', { class: 'mono muted' }, `${edge.fileName} : 第 ${edge.sourceLine} 行`) : null,
        ),
        h('p', { style: 'margin:8px 0 0' }, edge.detail),
        raw ? h('dl', { class: 'kv', style: 'margin-top:10px' },
          h('dt', {}, '原始时间戳'), h('dd', { class: 'mono' }, String(raw.rawTimestamp)),
          h('dt', {}, '原始字段'), h('dd', { class: 'mono' }, JSON.stringify(raw.rawFields)),
          h('dt', {}, '记录哈希'), h('dd', { class: 'mono' }, String(raw.recordHash)),
          h('dt', {}, '入库时间'), h('dd', { class: 'mono' }, new Date(raw.ingestedAt as string).toLocaleString('zh-CN')),
        ) : null,
      );
    });

    // 层级之间插箭头
    const withArrows: HTMLElement[] = [];
    nodes.forEach((n, i) => {
      if (i > 0) withArrows.push(h('div', { class: 'lineage-arrow' }, '▼'));
      withArrows.push(n);
    });

    modal(`数据血缘 · ${stationCode}${tsUtc ? ` · ${tsUtc}` : ` · ${statDate}`}`,
      h('div', {},
        nodes.length === 0 ? h('div', { class: 'empty' }, '未找到血缘数据') : h('div', {}, ...withArrows),
      ));
  } catch (err) {
    toast(`血缘查询失败：${(err as Error).message}`, 'err');
  }
}
