import { zh } from '/i18n/zh.js';
import { patch } from '/js/api.js';
import { store } from '/js/store.js';
import { esc } from '/js/util.js';
import { createReadingSession, normalizeReadingSettings, validateReadingSettings } from '/js/reading.js';

const keys = ['font_size', 'font_scale', 'font_family', 'font_weight', 'line_height', 'letter_spacing'];
const field = (key, control, extra = '') => `<div class="field reading-field">
  <label for="rd-${key}">${esc(zh.reading[key])}${extra}</label>${control}
  <div class="form-error" id="rd-${key}-err"></div></div>`;
const number = (key, min, max, step) => `<input class="input" type="number" id="rd-${key}" name="${key}" min="${min}" max="${max}" step="${step}" required aria-describedby="rd-${key}-err">`;
const range = (key, min, max, step, unit) => field(key,
  `<input type="range" id="rd-${key}" name="${key}" min="${min}" max="${max}" step="${step}" aria-describedby="rd-${key}-err">`,
  `<output for="rd-${key}" data-output="${key}"></output><span class="sr-only">${unit}</span>`);

export function readingFormHtml() {
  const R = zh.reading;
  return `<form class="panel panel-pad reading-form" data-reading novalidate aria-labelledby="rd-title">
    <h2 class="reading-title" id="rd-title">${esc(R.title)}</h2>
    <p class="reading-lead">${esc(R.lead)}</p>
    <fieldset class="reading-controls" aria-labelledby="rd-title">
      ${range('font_size', 14, 28, 1, R.pixels)}
      ${range('font_scale', 85, 130, 5, R.percent)}
      <details class="reading-details"><summary>${esc(R.advanced)}</summary>
        <div class="reading-grid">
          ${field('font_family', `<select class="input" id="rd-font_family" name="font_family" aria-describedby="rd-font_family-err">${Object.entries(R.families).map(([key, name]) => `<option value="${key}">${esc(name)}</option>`).join('')}</select>`)}
          ${field('font_weight', `<select class="input" id="rd-font_weight" name="font_weight" aria-describedby="rd-font_weight-err">${Object.entries(R.weights).map(([key, name]) => `<option value="${key}">${esc(name)}</option>`).join('')}</select>`)}
          ${field('line_height', number('line_height', 1.2, 2.4, .1))}
          ${field('letter_spacing', number('letter_spacing', -.5, 2, .1))}
        </div>
        <p class="reading-lead">${esc(R.font_hint)}</p>
      </details>
    </fieldset>
    <div class="reading-preview" aria-labelledby="rd-preview-title">
      <div class="reading-preview-label" id="rd-preview-title">${esc(R.preview)}</div>
      <p class="reading-preview-text">${esc(R.sample)}</p>
      <p class="reading-preview-text"><em>${esc(R.sample_action)}</em>${esc(R.sample_dialogue)}</p>
    </div>
    <p class="reading-status" data-reading-status role="status" aria-live="polite"></p>
    <div class="form-error" data-reading-error role="alert" tabindex="-1"></div>
    <div class="reading-actions">
      <button class="btn btn-primary" type="submit">${esc(R.save)}</button>
      <button class="btn" type="button" data-reading-reset>${esc(R.reset)}</button>
    </div>
  </form>`;
}

export function mountReadingSettings(form, ctx) {
  const R = zh.reading;
  const error = form.querySelector('[data-reading-error]');
  const status = form.querySelector('[data-reading-status]');
  const save = form.querySelector('[type="submit"]');
  const reset = form.querySelector('[data-reading-reset]');
  const controls = form.querySelector('fieldset');
  let busy = false;
  const active = () => ctx.isActive() && form.isConnected;
  const input = (key) => form.elements.namedItem(key);
  function outputs() {
    form.querySelector('[data-output="font_size"]').textContent = `${input('font_size').value} ${R.pixels}`;
    form.querySelector('[data-output="font_scale"]').textContent = `${input('font_scale').value}%`;
  }
  function fill(value, fields = keys) {
    const s = normalizeReadingSettings(value);
    for (const key of fields) input(key).value = key === 'font_scale' ? Math.round(s[key] * 100) : s[key];
    outputs();
  }
  const session = createReadingSession({
    getUser: () => store.me, persist: (body) => patch('/api/me', body),
    onDraftChange: (draft, { fields }) => {
      if (active()) fill(draft, fields.filter((key) => input(key).getAttribute('aria-invalid') !== 'true'));
    },
  });
  function values() {
    const s = {};
    for (const key of keys) {
      const raw = input(key).value;
      s[key] = key === 'font_family' ? raw : raw.trim() ? Number(raw) : NaN;
    }
    s.font_scale /= 100;
    return s;
  }
  function showErrors(errors) {
    for (const key of keys) {
      form.querySelector(`#rd-${key}-err`).textContent = errors[key] || '';
      if (errors[key]) input(key).setAttribute('aria-invalid', 'true');
      else input(key).removeAttribute('aria-invalid');
    }
  }
  function preview(event) {
    if (busy) return;
    outputs();
    error.textContent = '';
    const value = values(), key = event.target?.name;
    const result = validateReadingSettings(value);
    if (keys.includes(key) && !result.errors[key]) session.preview({ [key]: value[key] });
    showErrors(result.errors);
    if (!Object.keys(result.errors).length) status.textContent = R.unsaved;
  }
  function setBusy(value) {
    busy = value;
    controls.disabled = value;
    save.disabled = reset.disabled = value;
    save.textContent = value ? R.saving : R.save;
    form.setAttribute('aria-busy', String(value));
  }
  async function persist(resetDefault = false) {
    if (busy) return;
    const result = resetDefault ? { errors: {}, settings: null } : validateReadingSettings(values());
    showErrors(result.errors);
    error.textContent = '';
    if (Object.keys(result.errors).length) {
      input(Object.keys(result.errors)[0]).focus();
      return;
    }
    setBusy(true);
    try {
      const saved = await session.save(resetDefault ? null : undefined);
      if (!active() || !saved) return;
      fill(saved);
      status.textContent = resetDefault ? R.reset_done : R.saved;
    } catch (e) {
      if (!active()) return;
      error.textContent = e.message || zh.network_error;
      status.textContent = R.failed_restored;
      error.focus({ preventScroll: true });
    } finally { if (active()) setBusy(false); }
  }
  fill(store.me?.reading_settings);
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  form.addEventListener('submit', (e) => { e.preventDefault(); persist(); });
  reset.onclick = () => persist(true);
  ctx.onCleanup(() => session.dispose());
}
