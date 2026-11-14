/** 指标页：日均水位、月极值、超警戒时长，点击任意日指标下钻血缘。 */
import { queryDaily, queryMonthly, rebuildMetrics } from '../metrics/dws-service.ts';
import { listStations } from '../db/queries.ts';
import { openLineage } from './page-lineage.ts';
import { badge, clear, fmtMinutes, fmtNum, h, toast } from './dom.ts';

export async function renderMetrics(body: HTMLElement, actions: HTMLElement): Promise<void> {
  clear(body);
  clear(actions);
  const stations = await listStations();
  const stationCodes = stations.map((s) => String(s.stationCode));

  const stationFilter = h('select', {},
    h('option', { value: '' }, '全部站点'),
    ...stationCodes.map((c) => h('option', { value: c }, c)),
  );
  const monthFilter = h('input', { type: 'month' });

  actions.append(h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      toast('正在重算指标…', 'info', 60000);
      const r = await rebuildMetrics();
      toast(`指标重算完成：日指标 ${r.dailyRows} 行，月指标 ${r.monthlyRows} 行`, 'ok');
      await load();
    },
  }, '重算指标'));
  actions.append(stationFilter, monthFilter);

  const monthlyCard = h('div', { class: 'card' }, h('h2', {}, '月极值与超警戒时长'), h('div', { id: 'monthly' }));
  const dailyCard = h('div', { class: 'card' }, h('h2', {}, '日均水位（点击行查看当天血缘）'), h('div', { id: 'daily' }));
  body.append(monthlyCard, dailyCard);

  async function load(): Promise<void> {
    const station = stationFilter.value || undefined;
    const month = monthFilter.value || undefined;
    const monthly = await queryMonthly(station);
    const daily = await queryDaily(station, month);

    const mBox = document.getElementById('monthly')!;
    mBox.replaceChildren(monthly.length === 0 ? h('div', { class: 'empty' }, '暂无月指标') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '站码'), h('th', {}, '月份'),
          h('th', { class: 'num' }, '月均水位(m)'),
          h('th', { class: 'num' }, '最高水位(m)'), h('th', {}, '最高时刻'),
          h('th', { class: 'num' }, '最低水位(m)'), h('th', {}, '最低时刻'),
          h('th', { class: 'num' }, '超警戒时长'), h('th', { class: 'num' }, '样本数'),
        )),
        h('tbody', {}, ...monthly.map((m) => h('tr', {},
          h('td', {}, m.stationCode),
          h('td', { class: 'mono' }, m.statMonth),
          h('td', { class: 'num' }, fmtNum(m.avgLevelM)),
          h('td', { class: 'num' }, fmtNum(m.maxLevelM)),
          h('td', { class: 'mono' }, m.maxLevelTs ? fmtTs(m.maxLevelTs) : '—'),
          h('td', { class: 'num' }, fmtNum(m.minLevelM)),
          h('td', { class: 'mono' }, m.minLevelTs ? fmtTs(m.minLevelTs) : '—'),
          h('td', { class: 'num' }, fmtMinutes(m.overWarningMinutes)),
          h('td', { class: 'num' }, String(m.sampleCount)),
        ))),
      )));

    const dBox = document.getElementById('daily')!;
    dBox.replaceChildren(daily.length === 0 ? h('div', { class: 'empty' }, '暂无日指标') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '站码'), h('th', {}, '日期'),
          h('th', { class: 'num' }, '日均(m)'),
          h('th', { class: 'num' }, '最高(m)'), h('th', { class: 'num' }, '最低(m)'),
          h('th', { class: 'num' }, '采样'), h('th', { class: 'num' }, '缺测'),
          h('th', { class: 'num' }, '超警戒(分)'), h('th', {}, ''),
        )),
        h('tbody', {}, ...daily.map((d) => h('tr', {},
          h('td', {}, d.stationCode),
          h('td', { class: 'mono' }, d.statDate),
          h('td', { class: 'num' }, fmtNum(d.avgLevelM)),
          h('td', { class: 'num' }, fmtNum(d.maxLevelM)),
          h('td', { class: 'num' }, fmtNum(d.minLevelM)),
          h('td', { class: 'num' }, String(d.sampleCount)),
          h('td', { class: 'num' }, d.missingCount > 0
            ? badge(String(d.missingCount), 'warn') : String(0)),
          h('td', { class: 'num' }, d.overWarningMinutes > 0
            ? badge(fmtMinutes(d.overWarningMinutes), 'err') : '0'),
          h('td', {}, h('button', {
            class: 'btn btn-sm',
            onclick: () => void openLineage(d.stationCode, undefined, d.statDate),
          }, '追血缘')),
        ))),
      )));
  }

  stationFilter.addEventListener('change', () => void load());
  monthFilter.addEventListener('change', () => void load());
  await load();
}

function fmtTs(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19) + ' UTC';
}
