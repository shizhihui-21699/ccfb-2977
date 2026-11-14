/** 轻量 DOM 辅助与 UI 工具，无框架依赖。 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, kind: 'info' | 'ok' | 'err' = 'info', ms = 3200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast ${kind === 'info' ? '' : kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function badge(text: string, tone: 'ok' | 'warn' | 'err' | 'info' | 'muted'): HTMLSpanElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}

export function fmtNum(v: unknown, digits = 2): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : String(v);
}

export function fmtMinutes(min: number): string {
  if (!min) return '0 分钟';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

export function download(filename: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** 简单模态框 */
export function modal(title: string, body: HTMLElement, onClose?: () => void): () => void {
  const mask = h('div', { class: 'modal-mask' });
  const box = h('div', { class: 'modal' },
    h('h2', {}, title),
    body,
  );
  mask.append(box);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  const close = () => { mask.remove(); onClose?.(); };
  document.body.append(mask);
  return close;
}
