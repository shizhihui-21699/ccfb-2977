/** 数据源页：三个厂家数据源说明 + 可配置字段映射（目标字段、线性换算）。 */
import type { CanonicalField, FieldMapping } from '../types.ts';
import { updateMapping } from '../db/metadata.ts';
import { listDataSources, listMappings } from '../db/queries.ts';
import { badge, h, toast } from './dom.ts';

const CANONICAL_LABELS: Record<CanonicalField, string> = {
  station_code: '站码',
  ts_utc: 'UTC 时间',
  water_level_m: '水位(m)',
  flow_m3s: '流量(m³/s)',
  rainfall_mm: '降雨量(mm)',
  voltage_v: '电压(V)',
  quality_code: '质量码',
};
const CANONICAL_KEYS = Object.keys(CANONICAL_LABELS) as CanonicalField[];

const FORMAT_LABEL: Record<string, string> = {
  csv_qinghe: 'CSV（清河）',
  fixedwidth_yuanshan: '定宽文本（远山）',
  binary_lanshi: '二进制（蓝石）',
};

export async function renderDataSources(body: HTMLElement): Promise<void> {
  const sources = await listDataSources();
  const allMappings = await listMappings();
  body.replaceChildren();

  for (const ds of sources) {
    const mappings = allMappings.filter((m) => m.dataSourceId === ds.id);
    const rows = mappings.map((m) => buildMappingRow(m));

    body.append(h('div', { class: 'card' },
      h('div', { class: 'flex' },
        h('h2', { style: 'margin:0' }, `${ds.vendor}　`),
        badge(FORMAT_LABEL[ds.format] ?? ds.format, 'info'),
        h('span', { class: 'spacer' }),
        badge(ds.enabled ? '启用中' : '停用', ds.enabled ? 'ok' : 'muted'),
      ),
      h('p', { class: 'muted', style: 'margin:8px 0 14px' },
        `${ds.description}　|　默认时区：${ds.tzMode}${ds.manualTz ? `（${ds.manualTz}）` : ''}`),
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, '源字段'),
            h('th', {}, '映射到宽表字段'),
            h('th', { class: 'num' }, '系数 scale'),
            h('th', { class: 'num' }, '偏移 offset'),
            h('th', {}, '说明'),
          )),
          h('tbody', {}, ...rows),
        ),
      ),
    ));
  }

  body.append(h('div', { class: 'card' },
    h('h2', {}, '换算口径'),
    h('p', { class: 'muted', style: 'margin:0' },
      '标准值 =（原始值 + offset）× scale。例如蓝石水位以厘米存储，scale=0.01 转米；'
      + '目标字段选「—（忽略）」则该源字段不入库。修改即时保存，仅对后续导入生效，历史 ODS 原始值不变。'),
  ));
}

function buildMappingRow(m: FieldMapping): HTMLTableRowElement {
  const targetSelect = h('select', {},
    h('option', { value: '' }, '—（忽略）'),
    ...CANONICAL_KEYS.map((k) =>
      h('option', { value: k }, CANONICAL_LABELS[k])),
  );
  // 显式赋值比给 option 打 selected 属性更可靠（后者在动态插入时可能不生效）
  targetSelect.value = m.targetField ?? '';
  targetSelect.addEventListener('change', async () => {
    const v = targetSelect.value;
    m.targetField = v ? (v as CanonicalField) : null;
    await persist(m);
  });

  const scaleInput = h('input', { type: 'number', step: 'any', value: String(m.scale) });
  scaleInput.addEventListener('change', () => persist({ ...m, scale: Number(scaleInput.value) }));
  const offsetInput = h('input', { type: 'number', step: 'any', value: String(m.offset) });
  offsetInput.addEventListener('change', () => persist({ ...m, offset: Number(offsetInput.value) }));

  const isMeasure = m.targetField && m.targetField !== 'station_code' && m.targetField !== 'ts_utc';
  return h('tr', {},
    h('td', { class: 'mono' }, m.sourceField),
    h('td', {}, targetSelect),
    h('td', { class: 'num' }, scaleInput),
    h('td', { class: 'num' }, offsetInput),
    h('td', { class: 'muted' },
      m.builtin ? '内置映射' : '自定义',
      isMeasure && (m.scale !== 1 || m.offset !== 0) ? '，含单位换算' : ''),
  );
}

async function persist(m: FieldMapping): Promise<void> {
  try {
    await updateMapping(m);
    toast(`已保存映射：${m.sourceField}`, 'ok', 1600);
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'err');
  }
}
