// 应用内分享码面板（DOM 浮层）：大字号号码 + 一键复制 + 已复制反馈 + 关闭
// 不依赖剪贴板权限：即使复制失败，号码也始终完整可见，供手动记录。
// 文案由 sharePanelModel 统一生成，与编辑器画布内的同名面板保持一致。

import { copyText, sharePanelModel } from '../net/LevelShare';
import { UI } from './theme';

const STOP_EVENTS = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel'];

let activeClose: (() => void) | null = null;

export function openSharePanel(code: string): void {
  activeClose?.();

  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99998',
    'display:flex', 'align-items:center', 'justify-content:center',
    `background:${UI.color.scrim}`,
    "font-family:'Trebuchet MS','PingFang SC','Microsoft YaHei',sans-serif",
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'width:min(90vw,460px)', `background:${UI.paper}`, `border:3px solid ${UI.ink}`,
    'border-radius:16px', 'padding:18px 18px 14px', 'box-sizing:border-box',
    `box-shadow:0 12px 34px ${UI.shadow}`, 'text-align:center',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = '分享码已就绪！';
  title.style.cssText = `font-size:20px;font-weight:700;color:${UI.ink};margin-bottom:6px;`;

  const subtitle = document.createElement('div');
  subtitle.textContent = '把这串 8 位分享码发给好友';
  subtitle.style.cssText = `font-size:13px;color:${UI.color.sub};margin-bottom:12px;`;

  const model = sharePanelModel(code, false);

  const codeBox = document.createElement('div');
  codeBox.textContent = model.codeText;
  codeBox.style.cssText = [
    'font-family:ui-monospace,Consolas,monospace', 'font-size:30px', 'font-weight:700',
    'letter-spacing:1px', `color:${UI.color.accent}`, `background:${UI.paper}`,
    `border:2px dashed ${UI.ink}`, 'border-radius:12px', 'padding:12px 8px',
    'user-select:all', '-webkit-user-select:all', 'word-break:break-all',
  ].join(';');

  const hint = document.createElement('div');
  hint.textContent = model.hint;
  hint.style.cssText = `font-size:12px;color:${UI.color.sub};margin-top:10px;min-height:15px;`;

  const feedback = document.createElement('div');
  feedback.style.cssText = `font-size:12px;color:${UI.color.successInk};margin-top:4px;min-height:15px;`;

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:14px;';

  const makeBtn = (label: string, primary: boolean) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'min-width:130px', 'padding:11px 16px', 'border-radius:10px', 'font-size:15px',
      'font-weight:700', 'cursor:pointer', `border:2px solid ${UI.ink}`,
      primary ? `background:${UI.color.accent};color:${UI.ink}` : `background:${UI.paper};color:${UI.ink}`,
    ].join(';');
    return b;
  };

  const copyBtn = makeBtn('复制分享码', true);
  const closeBtn = makeBtn('关闭', false);

  const close = () => {
    root.remove();
    if (activeClose === close) activeClose = null;
  };

  const doCopy = async () => {
    const ok = await copyText(code);
    copyBtn.textContent = ok ? '已复制！' : '复制分享码';
    feedback.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动记录上方分享码';
    feedback.style.color = ok ? UI.color.successInk : UI.color.dangerInk;
  };

  copyBtn.addEventListener('click', () => { void doCopy(); });
  closeBtn.addEventListener('click', close);
  for (const ev of STOP_EVENTS) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }

  card.append(title, subtitle, codeBox, hint, feedback, row);
  row.append(copyBtn, closeBtn);
  root.append(card);
  document.body.appendChild(root);
  activeClose = close;

  // 打开即尝试复制；失败不影响号码展示
  void doCopy();
}
