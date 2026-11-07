import { h, icon, iconButton, toast, pickFiles, fill } from '../dom.js';
import { t } from '../i18n.js';
import {
  lib, DIFFICULTIES, CLASSIFICATIONS, newGroup, newTechnique, saveGroup, saveTechnique, setCover,
  subtreeGroupIds, canMoveGroup, validGroupId, byName, relatedOf, commit,
} from '../library.js';
import { chrome, $main, nav, goBack, routes, groupOptions } from '../ui.js';
import { urlFor, coverFromImage } from '../media.js';

function field(label, control, hint) {
  return h('label', { class: 'form-field' }, h('span', { class: 'form-label' }, label), control, hint ? h('span', { class: 'form-hint' }, hint) : null);
}

/** Typed text runs in its own direction; an empty field (and its hint) follows the page. */
export function followTyping(el) {
  const sync = () => { if (el.value) el.dir = 'auto'; else el.removeAttribute('dir'); };
  el.addEventListener('input', sync);
  sync();
  return el;
}

function textInput(value, attrs = {}) {
  const el = h('input', { class: 'field', type: 'text', value: value || '', autocomplete: 'off', ...attrs });
  return attrs.type === 'url' ? el : followTyping(el);
}

function textArea(value, rows = 3, attrs = {}) {
  const el = h('textarea', { class: 'field', rows, ...attrs });
  el.value = value || '';
  return followTyping(el);
}

function select(options, value) {
  const el = h('select', { class: 'field' }, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  return el;
}

const splitTags = (s) => s.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/** Links editor: rows of title + address. Returns { el, value() }. */
function linksEditor(links) {
  const rows = h('div', { class: 'link-rows' });
  const addRow = (l = { title: '', url: '' }) => {
    const title = textInput(l.title, { placeholder: t('editor.linkTitle'), 'aria-label': t('editor.linkTitle') });
    const url = textInput(l.url, { type: 'url', inputmode: 'url', dir: 'ltr', placeholder: 'https://…', 'aria-label': t('editor.linkUrl') });
    const row = h('div', { class: 'link-row-edit' }, title, url, iconButton('close', t('common.remove'), () => row.remove()));
    row._value = () => ({ title: title.value.trim(), url: url.value.trim() });
    rows.append(row);
  };
  (links || []).forEach(addRow);
  const el = h('div', {}, rows, h('button', { class: 'text-btn', type: 'button', onclick: () => addRow() }, icon('add', 18), t('editor.addLink')));
  return { el, value: () => [...rows.children].map((r) => r._value()).filter((l) => l.url) };
}

/** Cover picker. Returns { el, result() } where result is undefined (unchanged), null (removed) or a Blob. */
function coverEditor(currentKey) {
  let next; // undefined = unchanged
  const preview = h('div', { class: 'cover-preview' });
  const show = async () => {
    if (next === null || (next === undefined && !currentKey)) {
      fill(preview, h('span', { class: 'muted small' }, t('editor.noCover')));
      removeBtn.hidden = true;
      return;
    }
    const url = next ? URL.createObjectURL(next) : await urlFor(currentKey);
    fill(preview, url ? h('img', { src: url, alt: '' }) : null);
    removeBtn.hidden = false;
  };
  const chooseBtn = h('button', {
    class: 'btn tonal', type: 'button',
    onclick: async () => {
      const [file] = await pickFiles({ accept: 'image/*' });
      if (!file) return;
      try { next = await coverFromImage(file); } catch { next = file; }
      show();
    },
  }, icon('image', 18), t('editor.chooseCover'));
  const removeBtn = h('button', { class: 'text-btn', type: 'button', onclick: () => { next = null; show(); } }, t('common.remove'));
  show();
  return { el: h('div', { class: 'cover-edit' }, preview, h('div', { class: 'row' }, chooseBtn, removeBtn)), result: () => next };
}

/** "Leads to" checklist with a filter box. */
function leadsToEditor(selfId, selected) {
  const chosen = new Set(selected || []);
  const filter = followTyping(h('input', { class: 'field', type: 'search', placeholder: t('editor.filterTechniques'), autocomplete: 'off' }));
  const list = h('div', { class: 'checklist' });
  const all = [...lib.techniques.values()].filter((x) => x.id !== selfId).sort(byName);
  const draw = () => {
    const q = filter.value.trim().toLocaleLowerCase();
    const shown = all.filter((x) => chosen.has(x.id) || !q || x.name.toLocaleLowerCase().includes(q));
    fill(list, shown.length ? shown.map((x) => {
      const box = h('input', { type: 'checkbox', checked: chosen.has(x.id), onchange: (e) => { if (e.target.checked) chosen.add(x.id); else chosen.delete(x.id); } });
      const where = validGroupId(x.groupId) ? lib.groups.get(x.groupId).name : null;
      return h('label', { class: 'check' }, box, h('span', {}, h('span', { dir: 'auto' }, x.name), where ? h('small', {}, ' · ', h('span', { dir: 'auto' }, where)) : null));
    }) : h('p', { class: 'muted small' }, all.length ? t('search.none') : t('editor.noOtherTechniques')));
  };
  filter.addEventListener('input', draw);
  draw();
  return { el: h('div', {}, all.length > 8 ? filter : null, list), value: () => all.filter((x) => chosen.has(x.id)).map((x) => x.id) };
}

function saveBar(onSave) {
  return h('button', { class: 'text-btn save-btn', type: 'button', onclick: onSave }, t('common.save'));
}

// --- technique ----------------------------------------------------------------------------------

export function renderTechniqueEditor({ id, inGroup }) {
  const existing = id ? lib.techniques.get(id) : null;
  if (id && !existing) { nav('/', { replace: true }); return; }
  const x = existing ? { ...existing } : newTechnique(inGroup === 'root' ? null : inGroup);

  const name = textInput(x.name, { required: true, maxlength: 200, enterkeyhint: 'next' });
  const folder = h('select', { class: 'field' }, groupOptions(validGroupId(x.groupId)));
  const difficulty = select(DIFFICULTIES.map((d) => [d, t(`difficulty.${d}`)]), x.difficulty);
  const classification = select(CLASSIFICATIONS.map((c) => [c, t(`classification.${c}`)]), x.classification);
  const position = textInput(x.position, { placeholder: t('editor.positionHint') });
  const description = textArea(x.description, 3);
  const steps = textArea((x.steps || []).join('\n'), 5);
  const tags = textInput((x.tags || []).join(', '), { placeholder: t('editor.tagsHint') });
  const notes = textArea(x.notes, 3);
  const links = linksEditor(x.links);
  const leads = leadsToEditor(x.id, x.leadsToIds);
  const related = leadsToEditor(x.id, relatedOf(x.id).map((r) => r.id));
  const cover = coverEditor(x.coverKey);

  const save = async () => {
    const n = name.value.trim();
    if (!n) { name.focus(); toast(t('editor.nameRequired')); return; }
    const row = {
      ...x, name: n, groupId: folder.value || null, difficulty: difficulty.value, classification: classification.value,
      position: position.value.trim(), description: description.value.trim(), steps: splitLines(steps.value),
      tags: splitTags(tags.value), notes: notes.value.trim(), links: links.value(), leadsToIds: leads.value(),
      relatedIds: related.value(),
    };
    // A related link has no direction: un-ticking one also clears it on the other technique.
    const keep = new Set(row.relatedIds);
    const others = [...lib.techniques.values()]
      .filter((o) => o.id !== row.id && (o.relatedIds || []).includes(row.id) && !keep.has(o.id))
      .map((o) => ({ ...o, relatedIds: o.relatedIds.filter((r) => r !== row.id) }));
    await commit({ techniques: [{ ...row, modifiedAt: Date.now() }, ...others] });
    const c = cover.result();
    if (c !== undefined) await setCover('technique', row.id, c);
    toast(t('editor.saved'));
    if (existing) goBack(routes.technique(row.id));
    else nav(routes.technique(row.id), { replace: true });
  };

  chrome({
    title: existing ? t('editor.editTechnique') : t('editor.newTechnique'),
    back: existing ? routes.technique(x.id) : routes.group(validGroupId(x.groupId)),
    tab: 'library',
    actions: [saveBar(save)],
  });

  fill($main(), h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    field(t('editor.name'), name),
    field(t('editor.folder'), folder),
    h('div', { class: 'form-2' }, field(t('editor.difficulty'), difficulty), field(t('editor.classification'), classification)),
    field(t('editor.position'), position),
    field(t('technique.description'), description),
    field(t('technique.steps'), steps, t('editor.stepsHint')),
    field(t('editor.tags'), tags),
    field(t('technique.notes'), notes),
    h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, t('technique.links')), links.el),
    h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, t('technique.leadsTo')), h('span', { class: 'form-hint' }, t('editor.leadsToHint')), leads.el),
    h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, t('technique.related')), related.el),
    h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, t('editor.cover')), cover.el),
    h('button', { class: 'btn block', type: 'submit' }, t('common.save'))));
  if (!existing) setTimeout(() => name.focus(), 50);
}

// --- group ---------------------------------------------------------------------------------------

export function renderGroupEditor({ id, inGroup }) {
  const existing = id ? lib.groups.get(id) : null;
  if (id && !existing) { nav('/', { replace: true }); return; }
  const g = existing ? { ...existing } : newGroup(inGroup === 'root' ? null : inGroup);

  const name = textInput(g.name, { required: true, maxlength: 200 });
  const parent = h('select', { class: 'field' }, groupOptions(validGroupId(g.parentId), existing ? subtreeGroupIds(g.id) : new Set()));
  const description = textArea(g.description, 3);
  const tags = textInput((g.tags || []).join(', '), { placeholder: t('editor.tagsHint') });
  const notes = textArea(g.notes, 3);
  const cover = coverEditor(g.coverKey);

  const save = async () => {
    const n = name.value.trim();
    if (!n) { name.focus(); toast(t('editor.nameRequired')); return; }
    const parentId = parent.value || null;
    if (existing && !canMoveGroup(g.id, parentId)) { toast(t('editor.cantMoveInside')); return; }
    const row = { ...g, name: n, parentId, description: description.value.trim(), tags: splitTags(tags.value), notes: notes.value.trim() };
    await saveGroup(row);
    const c = cover.result();
    if (c !== undefined) await setCover('group', row.id, c);
    toast(t('editor.saved'));
    if (existing) goBack(routes.group(row.id));
    else nav(routes.group(row.id), { replace: true });
  };

  chrome({
    title: existing ? t('editor.editGroup') : t('editor.newGroup'),
    back: existing ? routes.group(g.id) : routes.group(validGroupId(g.parentId)),
    tab: 'library',
    actions: [saveBar(save)],
  });

  fill($main(), h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    field(t('editor.name'), name),
    field(t('editor.parent'), parent),
    field(t('technique.description'), description),
    field(t('editor.tags'), tags),
    field(t('technique.notes'), notes),
    h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, t('editor.cover')), cover.el),
    h('button', { class: 'btn block', type: 'submit' }, t('common.save'))));
  if (!existing) setTimeout(() => name.focus(), 50);
}
