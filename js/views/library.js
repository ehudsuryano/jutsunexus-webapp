import { h, icon, iconButton, menu, confirmDialog, toast, fill, sheet } from '../dom.js';
import { getPref, setPref, VIEW_MODES, SORT_OPTIONS } from '../prefs.js';
import { t, tn } from '../i18n.js';
import { lib, childGroups, childTechniques, techniquesUnder, mediaOf, deleteGroup, search as searchLibrary, validGroupId, DIFFICULTIES, byName } from '../library.js';
import { chrome, $main, nav, routes, groupRow, techniqueRow, tagChips, isIos, isStandalone } from '../ui.js';
import { openPlayer } from '../player.js';
import { shareExport } from '../share.js';
import { followTyping } from './editors.js';
import { layoutSwitch, setLibraryLayout } from '../graph/view.js';

/** Every video under a group (null = whole library), in browsing order, for "Play all". */
export function videosUnder(groupId) {
  return techniquesUnder(groupId).flatMap((x) =>
    mediaOf(x.id).filter((m) => m.type === 'VIDEO').map((m) => ({ media: m, title: x.name })));
}

export function playAll(groupId) {
  const items = videosUnder(groupId);
  if (items.length === 0) { toast(t('library.noVideos')); return; }
  openPlayer(items, 0, { playlist: true });
}

export function addMenu(groupId) {
  const here = groupId || 'root';
  menu(t('library.add'), [
    { label: t('library.newTechnique'), icon: 'technique', onSelect: () => nav(`/new/t/${here}`) },
    { label: t('library.newGroup'), icon: 'folder', onSelect: () => nav(`/new/g/${here}`) },
    { label: t('library.importHere'), icon: 'download', onSelect: () => nav(`/import/${here}`) },
  ]);
}

function groupMenu(g) {
  menu(g.name, [
    { label: t('common.edit'), icon: 'edit', onSelect: () => nav(`/g/${g.id}/edit`) },
    { label: t('library.playAll'), icon: 'play', onSelect: () => playAll(g.id) },
    { label: t('share.packageMedia'), icon: 'share', onSelect: () => shareExport({ kind: 'group', id: g.id }, true) },
    { label: t('share.packageText'), icon: 'share', onSelect: () => shareExport({ kind: 'group', id: g.id }, false) },
    {
      label: t('common.delete'), icon: 'trash', danger: true,
      onSelect: async () => {
        const n = techniquesUnder(g.id).length;
        const ok = await confirmDialog({
          title: t('library.deleteGroupTitle', { name: g.name }),
          body: n > 0 ? tn('library.deleteGroupBody', n) : t('library.deleteGroupEmpty'),
          ok: t('common.delete'), cancel: t('common.cancel'), danger: true,
        });
        if (!ok) return;
        const parent = validGroupId(g.parentId);
        await deleteGroup(g.id);
        toast(t('library.deleted'));
        nav(routes.group(parent), { replace: true });
      },
    },
  ]);
}

function rootMenu() {
  menu(t('library.title'), [
    { label: t('library.playAll'), icon: 'play', onSelect: () => playAll(null) },
    { label: t('more.backup'), icon: 'download', onSelect: () => shareExport({ kind: 'library' }, true) },
  ]);
}

function welcome() {
  return h('div', { class: 'welcome' },
    h('img', { class: 'welcome-logo', src: 'logo.png', alt: 'JutsuNexus', width: 600, height: 307 }),
    h('p', { class: 'muted' }, t('home.intro')),
    h('div', { class: 'stack' },
      h('a', { class: 'btn block', href: '#/import/root' }, icon('download', 20), t('home.import')),
      h('a', { class: 'btn tonal block', href: '#/new/t/root' }, icon('add', 20), t('home.create'))),
    installHint());
}

export function installHint() {
  if (isStandalone()) return null;
  return h('div', { class: 'card hint' },
    h('h2', {}, t('install.title')),
    isIos()
      ? h('ol', {}, h('li', {}, t('install.ios1')), h('li', {}, t('install.ios2')), h('li', {}, t('install.ios3')))
      : h('p', {}, t('install.other')),
    h('p', { class: 'small' }, t('install.why')));
}

export function renderGroup(groupId) {
  const g = groupId ? lib.groups.get(groupId) : null;
  if (groupId && !g) { nav('/', { replace: true }); return; }
  const id = g ? g.id : null;
  const groups = childGroups(id);
  const techniques = childTechniques(id);
  const isEmptyLibrary = !g && lib.groups.size === 0 && lib.techniques.size === 0;

  chrome({
    title: g ? g.name : t('library.title'),
    back: g ? routes.group(validGroupId(g.parentId)) : null,
    tab: 'library',
    crumbs: g ? validGroupId(g.parentId) : undefined,
    crumbLeaf: g ? g.name : undefined,
    actions: [
      iconButton('add', t('library.add'), () => addMenu(id)),
      isEmptyLibrary ? null : iconButton('more', t('common.more'), () => (g ? groupMenu(g) : rootMenu())),
    ],
  });

  if (isEmptyLibrary) { fill($main(), welcome()); return; }
  setLibraryLayout('LIST');

  const head = g && (g.description || (g.tags && g.tags.length) || g.notes)
    ? h('div', { class: 'group-head' },
        g.description ? h('p', { class: 'muted prose', dir: 'auto' }, g.description) : null,
        tagChips(g.tags),
        g.notes ? h('p', { class: 'small muted prose', dir: 'auto' }, g.notes) : null)
    : null;

  const sortOption = getPref('sortOption');
  const viewMode = getPref('viewMode');
  const list = groups.length || techniques.length
    ? h('div', { class: `list view-${viewMode.toLowerCase()}` }, sortItems(groups, sortOption).map(groupRow), sortItems(techniques, sortOption).map(techniqueRow))
    : h('div', { class: 'empty' },
        h('p', {}, t('library.emptyGroup')),
        h('button', { class: 'btn tonal', type: 'button', onclick: () => addMenu(id) }, icon('add', 20), t('library.add')));

  fill($main(), h('div', { class: 'list-top' }, layoutSwitch('LIST', id), h('span', { class: 'spacer' }),
    iconButton('tune', t('view.options'), () => viewOptions(() => renderGroup(groupId)))), head, list, !g ? installHint() : null);
}

/** Groups and techniques in the order picked in View options (groups always come first). */
function sortItems(items, option) {
  if (option === 'MODIFIED') return [...items].sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  if (option === 'CREATED') return [...items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return items; // already by name
}

function viewOptions(rerender) {
  let close;
  const radio = (name, value, label) => h('label', { class: 'check' },
    h('input', { type: 'radio', name, checked: getPref(name) === value, onchange: () => { setPref(name, value); close(); rerender(); } }),
    h('span', {}, label));
  close = sheet(h('div', { class: 'dialog' },
    h('h2', {}, t('view.options')),
    h('p', { class: 'form-label' }, t('view.show')),
    VIEW_MODES.map((v) => radio('viewMode', v, t(`view.${v}`))),
    h('p', { class: 'form-label', style: { marginTop: '14px' } }, t('view.sortBy')),
    SORT_OPTIONS.map((v) => radio('sortOption', v, t(`sort.${v}`))),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'btn tonal', type: 'button', onclick: () => close() }, t('common.close')))));
}

// --- search ---------------------------------------------------------------------------------------

let lastQuery = '';
const filters = { favorites: false, difficulty: null };

export function renderSearch() {
  chrome({ title: t('search.title'), tab: 'search' });
  const results = h('div', { class: 'list' });
  const input = h('input', {
    type: 'search', class: 'field', placeholder: t('search.placeholder'), value: lastQuery,
    autocomplete: 'off', enterkeyhint: 'search', 'aria-label': t('search.title'),
  });
  // Filters as in the app's search: favourites only, one difficulty.
  const favChip = h('button', { class: `pl-chip filter-chip${filters.favorites ? ' on' : ''}`, type: 'button', 'aria-pressed': String(filters.favorites) }, icon('star', 16), t('search.favorites'));
  const diff = h('select', { class: 'scope-select filter-select', 'aria-label': t('editor.difficulty') },
    h('option', { value: '' }, t('search.anyDifficulty')),
    DIFFICULTIES.filter((d) => d !== 'UNSPECIFIED').map((d) => h('option', { value: d, selected: filters.difficulty === d }, t(`difficulty.${d}`))));
  favChip.addEventListener('click', () => {
    filters.favorites = !filters.favorites;
    favChip.classList.toggle('on', filters.favorites);
    favChip.setAttribute('aria-pressed', String(filters.favorites));
    run();
  });
  diff.addEventListener('change', () => { filters.difficulty = diff.value || null; diff.classList.toggle('on', !!filters.difficulty); run(); });
  diff.classList.toggle('on', !!filters.difficulty);
  const run = () => {
    lastQuery = input.value;
    const filtered = filters.favorites || filters.difficulty;
    const keep = (x) => (!filters.favorites || x.isFavorite) && (!filters.difficulty || x.difficulty === filters.difficulty);
    let groups = [];
    let techniques = [];
    if (lastQuery.trim()) ({ groups, techniques } = searchLibrary(lastQuery));
    else if (filtered) techniques = [...lib.techniques.values()].sort(byName);
    if (filtered) { techniques = techniques.filter(keep); groups = []; }
    if (!lastQuery.trim() && !filtered) { fill(results, h('p', { class: 'empty small' }, t('search.hint'))); return; }
    if (groups.length + techniques.length === 0) { fill(results, h('p', { class: 'empty' }, t('search.none'))); return; }
    fill(results, techniques.map(techniqueRow), groups.map(groupRow));
  };
  input.addEventListener('input', run);
  followTyping(input);
  fill($main(), h('div', { class: 'search-box' }, icon('search', 20), input), h('div', { class: 'row filters' }, favChip, diff), results);
  run();
  setTimeout(() => input.focus(), 50);
}

