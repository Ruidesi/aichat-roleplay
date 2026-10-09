// 文件会话的「文件资料」弹层（契约 §17.1 / §17.3）：文件列表、一句话说明、上下文模式、可展开抽出的正文。
// 聊天页读取当前用户自己的文件正文（GET /api/chats/:id/file-text）。
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, fmtInt, numOrNull } from '/js/util.js';
import { icon, openSheet, spinnerHtml } from '/js/ui.js';
import { fileChatFiles } from '/js/cards.js';

const SHOW_MAX = 200000; // 弹层里最多显示这么多字，免得超长正文卡住页面

/** 文件列表 + 说明的 HTML（不含正文） */
export function fileInfoHtml(file) {
  const F = zh.filechat;
  const f = file || {};
  const files = fileChatFiles({ file: f });
  const total = numOrNull(f.total_chars);
  return `
    <div class="fi-sec">
      <div class="fi-label">${esc(F.info_files)}${total != null ? ` · ${esc(F.total(fmtInt(total)))}` : ''}</div>
      <ul class="fi-files">${files.map((x) => {
        const ok = x.ok !== false && !x.error;
        return `<li class="${ok ? '' : 'bad'}">${icon(ok ? 'file' : 'alert')}<span class="fi-name">${esc(x.name || '')}</span><span class="fi-chars">${esc(ok ? F.file_ok(fmtInt(x.chars)) : (x.error || F.file_failed))}</span></li>`;
      }).join('') || `<li>${esc(zh.none)}</li>`}</ul>
    </div>
    <div class="fi-sec">
      <div class="fi-label">${esc(F.info_instruction)}</div>
      <div class="fi-text${f.instruction ? '' : ' muted'}">${esc(f.instruction || F.info_no_instruction)}</div>
    </div>
    ${f.mode ? `<p class="fi-mode">${esc(f.mode === 'retrieval' ? F.info_mode_retrieval : F.info_mode_full)}</p>` : ''}`;
}

/**
 * 打开文件资料弹层。
 * file: {files, instruction, mode, total_chars, text?}；textUrl: 取全文的接口（返回 {text}），没有 text 时才用。
 */
export function openFileInfo({ file, textUrl }) {
  const F = zh.filechat;
  const s = openSheet(`
    <div class="sheet-title">${esc(F.info_title)}</div>
    ${fileInfoHtml(file)}
    <button class="btn btn-sm fi-toggle" type="button" data-text aria-expanded="false">${icon('book')}<span>${esc(F.view_text)}</span></button>
    <div class="fi-body" data-body hidden></div>
    <div class="sheet-actions"><button class="btn" type="button" data-a="close">${esc(zh.close)}</button></div>`, { label: F.info_title });
  s.el.querySelector('[data-a="close"]').onclick = () => s.close();
  wireTextToggle(s.el, { file, textUrl });
  return s;
}

/** 「查看抽出的正文」展开 / 收起（按需加载一次） */
export function wireTextToggle(rootEl, { file, textUrl }) {
  const F = zh.filechat;
  const tb = rootEl.querySelector('[data-text]');
  const body = rootEl.querySelector('[data-body]');
  if (!tb || !body) return;
  let loaded = false;
  const draw = (text) => {
    const t = String(text || '');
    const cut = t.length > SHOW_MAX;
    body.innerHTML = `${cut ? `<p class="fi-cut">${esc(F.text_cut(fmtInt(SHOW_MAX)))}</p>` : ''}<pre class="fi-pre"></pre>`;
    body.querySelector('pre').textContent = cut ? t.slice(0, SHOW_MAX) : t;
  };
  tb.onclick = async () => {
    const open = body.hidden;
    body.hidden = !open;
    tb.setAttribute('aria-expanded', String(open));
    tb.querySelector('span').textContent = open ? F.hide_text : F.view_text;
    if (!open || loaded) return;
    if (file && typeof file.text === 'string') { loaded = true; draw(file.text); return; }
    body.innerHTML = spinnerHtml();
    try {
      const r = await get(textUrl);
      loaded = true;
      draw(r && (typeof r.text === 'string' ? r.text : r.file && r.file.text));
    } catch (e) {
      body.innerHTML = `<p class="form-error">${esc(e.message || zh.network_error)}</p>`;
    }
  };
}
