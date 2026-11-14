/** 质控页：规则参数、重跑自动质控、标记列表、人工复核与人工加标。 */
import type { QcFlag, QcFlagType, QcSeverity } from '../types.ts';
import {
  addManualFlag, getRules, listFlags, reviewFlag, runAutoQc, saveRules,
} from '../qc/engine.ts';
import { browseDwd } from '../db/queries.ts';
import { badge, clear, h, modal, toast } from './dom.ts';

const FLAG_LABEL: Record<QcFlagType, string> = {
  jump: '跳变', range: '超量程', frozen: '长时间不变', missing: '缺测', manual: '人工',
};
const SEV_TONE: Record<QcSeverity, 'err' | 'warn' | 'ok'> = {
  error: 'err', warning: 'warn', ok: 'ok',
};

export async function renderQc(body: HTMLElement, actions: HTMLElement): Promise<void> {
  clear(body);
  clear(actions);
  const rules = await getRules();

  actions.append(h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      toast('正在重跑自动质控…', 'info', 60000);
      const stats = await runAutoQc();
      toast(`质控完成：覆盖 ${stats.stations} 站，写入 ${stats.inserted} 条自动标记`, 'ok');
      await renderQc(body, actions);
    },
  }, '重跑自动质控'));

  // ---- 规则参数 ----
  const numField = (label: string, key: keyof typeof rules, step = 'any') => {
    const input = h('input', { type: 'number', step, value: String(rules[key]) });
    input.addEventListener('change', () => {
      (rules[key] as number) = Number(input.value);
    });
    return h('label', { class: 'flex', style: 'gap:8px' }, h('span', { class: 'muted' }, label), input);
  };

  const ruleCard = h('div', { class: 'card' },
    h('h2', {}, '质控规则参数'),
    h('div', { class: 'pill-row', style: 'align-items:center' },
      numField('期望采样间隔(分)', 'expectedIntervalMin', '1'),
      numField('缺测容忍间隔数', 'missingToleranceIntervals', '1'),
      numField('跳变阈值(m)', 'jumpThresholdM'),
      numField('连续冻结点数', 'frozenCount', '1'),
      numField('警戒水位(m)', 'warningLevelM'),
    ),
    h('h3', {}, '量程'),
    h('div', { class: 'pill-row', style: 'align-items:center' },
      numField('水位下限', 'levelRange'),
      numField('水位上限', 'levelRange'),
      numField('流量下限', 'flowRange'),
      numField('流量上限', 'flowRange'),
      numField('电压下限', 'voltageRange'),
      numField('电压上限', 'voltageRange'),
    ),
    h('div', { style: 'margin-top:14px' }, h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        await saveRules(rules);
        toast('规则参数已保存', 'ok');
      },
    }, '保存参数')),
  );
  // 量程是二元组，上面的通用字段无法直接绑定，单独构建量程输入
  buildRangeInputs(ruleCard, rules);

  // ---- 标记列表 ----
  const listCard = h('div', { class: 'card' },
    h('div', { class: 'flex' },
      h('h2', { style: 'margin:0' }, '质控标记'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: () => void openManualAdd() }, '人工加标'),
    ),
    h('div', { id: 'flag-list', style: 'margin-top:12px' }, '加载中…'),
  );

  body.append(ruleCard, listCard);
  await refreshFlags();
}

function buildRangeInputs(card: HTMLElement, rules: Awaited<ReturnType<typeof getRules>>): void {
  const ranges: [string, 'levelRange' | 'flowRange' | 'voltageRange'][] = [
    ['水位', 'levelRange'], ['流量', 'flowRange'], ['电压', 'voltageRange'],
  ];
  const container = card.querySelectorAll('.pill-row')[1];
  container.replaceChildren();
  for (const [label, key] of ranges) {
    const lo = h('input', { type: 'number', step: 'any', value: String(rules[key][0]) });
    const hi = h('input', { type: 'number', step: 'any', value: String(rules[key][1]) });
    lo.addEventListener('change', () => { rules[key][0] = Number(lo.value); });
    hi.addEventListener('change', () => { rules[key][1] = Number(hi.value); });
    container.append(h('label', { class: 'flex', style: 'gap:6px' },
      h('span', { class: 'muted' }, `${label} `), lo, h('span', { class: 'muted' }, '~'), hi));
  }
}

async function refreshFlags(): Promise<void> {
  const box = document.getElementById('flag-list');
  if (!box) return;
  const flags = await listFlags(undefined, 500);
  if (flags.length === 0) {
    box.replaceChildren(h('div', { class: 'empty' }, '暂无标记，点击右上角「重跑自动质控」'));
    return;
  }
  box.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '站码'), h('th', {}, 'UTC 时间'), h('th', {}, '类型'),
      h('th', {}, '级别'), h('th', {}, '来源'), h('th', {}, '说明'),
      h('th', {}, '复核状态'), h('th', {}, '操作'),
    )),
    h('tbody', {}, ...flags.map((f) => h('tr', {},
      h('td', {}, f.stationCode),
      h('td', { class: 'mono' }, f.tsUtc.replace('T', ' ').replace('Z', ' UTC')),
      h('td', {}, badge(FLAG_LABEL[f.flagType], 'info')),
      h('td', {}, badge(f.severity === 'error' ? '错误' : '预警', SEV_TONE[f.severity])),
      h('td', {}, f.source === 'auto' ? badge('自动', 'muted') : badge('人工', 'warn')),
      h('td', { class: 'muted' }, f.message),
      h('td', {}, reviewBadge(f.reviewStatus)),
      h('td', { class: 'flex' },
        h('button', {
          class: 'btn btn-sm',
          onclick: () => void doReview(f.id, 'confirmed'),
        }, '确认'),
        h('button', {
          class: 'btn btn-sm',
          onclick: () => void doReview(f.id, 'cleared'),
        }, '清除'),
      ),
    ))),
  )));
}

function reviewBadge(status: QcFlag['reviewStatus']): HTMLElement {
  if (status === 'confirmed') return badge('已确认', 'ok');
  if (status === 'cleared') return badge('已清除', 'muted');
  return badge('待复核', 'warn');
}

async function doReview(id: number, action: 'confirmed' | 'cleared'): Promise<void> {
  await reviewFlag(id, action, '值班员');
  toast(`标记已${action === 'confirmed' ? '确认' : '清除'}`, 'ok', 1500);
  await refreshFlags();
}

async function openManualAdd(): Promise<void> {
  const { rows } = await browseDwd({ limit: 50 });
  const station = h('input', { placeholder: '如 QH01', value: rows[0]?.stationCode ?? '' });
  const ts = h('input', { placeholder: '2026-07-01T00:00:00Z', value: rows[0]?.tsUtc ?? '' });
  const type = h('select', {},
    ...(['jump', 'range', 'frozen', 'missing'] as QcFlagType[]).map((t) =>
      h('option', { value: t }, FLAG_LABEL[t])));
  const severity = h('select', {},
    h('option', { value: 'warning' }, '预警'),
    h('option', { value: 'error' }, '错误'));
  const message = h('input', { placeholder: '人工说明', value: '人工标记' });

  const close = modal('人工加标', h('div', {},
    field('站码', station), field('UTC 时间', ts), field('类型', type),
    field('级别', severity), field('说明', message),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', onclick: () => close() }, '取消'),
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await addManualFlag(station.value, ts.value,
              type.value as QcFlagType, severity.value as QcSeverity, message.value);
            toast('人工标记已保存', 'ok');
            close();
            await refreshFlags();
          } catch (err) {
            toast(`保存失败：${(err as Error).message}`, 'err');
          }
        },
      }, '保存'),
    ),
  ));
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'flex', style: 'margin-bottom:12px;gap:10px' },
    h('span', { class: 'muted', style: 'width:80px' }, label), input);
}
