// 应用内文本输入浮层：用 DOM 覆盖在画布上，替代 Android WebView 的系统 prompt
// 背景：Capacitor 的 onJsPrompt 不填预填值，导致“分享码”等输入框永远空白；
// 这里提供可预填、可选中、受应用样式控制的输入框，并阻止事件穿透到游戏输入。

import { UI } from './theme';

export interface TextInputOptions {
  title: string;
  placeholder?: string;
  value?: string;
  maxLength?: number;
  hint?: string;
  okLabel?: string;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

let activeClose: (() => void) | null = null;

const STOP_EVENTS = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel'];

export function openTextInput(opts: TextInputOptions): void {
  activeClose?.();

  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'display:flex', 'align-items:center', 'justify-content:center',
    `background:${UI.color.scrim}`,
    "font-family:'Trebuchet MS','PingFang SC','Microsoft YaHei',sans-serif",
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'width:min(88vw,440px)', `background:${UI.paper}`, `border:3px solid ${UI.ink}`,
    'border-radius:16px', 'padding:18px 18px 14px', 'box-sizing:border-box',
    `box-shadow:0 12px 34px ${UI.shadow}`,
  ].join(';');

  const title = document.createElement('div');
  title.textContent = opts.title;
  title.style.cssText = `font-size:17px;font-weight:700;color:${UI.ink};margin-bottom:10px;`;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = opts.value ?? '';
  input.placeholder = opts.placeholder ?? '';
  input.maxLength = opts.maxLength ?? 2000;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText = [
    'width:100%', 'box-sizing:border-box', 'padding:10px 12px',
    'font-size:16px', `color:${UI.ink}`, `background:${UI.paper}`,
    `border:2px solid ${UI.ink}`, 'border-radius:10px', 'outline:none',
  ].join(';');

  const hint = document.createElement('div');
  hint.textContent = opts.hint ?? '';
  hint.style.cssText = `font-size:12px;color:${UI.color.sub};margin-top:8px;min-height:15px;`;

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:14px;';

  const makeBtn = (label: string, primary: boolean) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'min-width:96px', 'padding:10px 16px', 'border-radius:10px', 'font-size:15px',
      'font-weight:700', 'cursor:pointer', `border:2px solid ${UI.ink}`,
      primary ? `background:${UI.color.accent};color:${UI.ink}` : `background:${UI.paper};color:${UI.ink}`,
    ].join(';');
    return b;
  };

  const cancel = makeBtn('取消', false);
  const ok = makeBtn(opts.okLabel ?? '确定', true);

  const close = () => {
    root.remove();
    if (activeClose === close) activeClose = null;
    document.removeEventListener('keydown', onKey, true);
  };

  const submit = () => {
    const v = input.value.trim();
    close();
    opts.onSubmit(v);
  };
  const dismiss = () => {
    close();
    opts.onCancel?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  cancel.addEventListener('click', dismiss);
  ok.addEventListener('click', submit);
  // 输入框内的按键不能被游戏输入捕获
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());

  // 浮层所有事件都止于这里，避免穿透触发画布编辑/拖拽
  for (const ev of STOP_EVENTS) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }
  document.addEventListener('keydown', onKey, true);

  card.append(title, input, hint, row);
  row.append(cancel, ok);
  root.append(card);
  document.body.appendChild(root);

  activeClose = close;
  setTimeout(() => { input.focus(); input.select(); }, 30);
}
