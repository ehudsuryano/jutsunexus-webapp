/**
 * JutsuNexus web app — the library on any phone browser (iPhone first), stored on the device.
 *
 * Routes live in the URL fragment so the static host never sees them:
 *   #/  #/g/<id>  #/t/<id>  #/t/<id>/edit  #/g/<id>/edit  #/new/t/<group|root>  #/new/g/<group|root>
 *   #/import  #/import/<group|root>  #/link/<t1.token>  #/search  #/more
 *   #/graph/<group|all>[/<technique to show>]  #/map/<technique>  #/qr/<technique>  #/youtube/<technique>  #/profile
 * A technique link's own fragment (#t1.…) and ?open=<package link> are accepted on arrival too.
 */
import { load } from './library.js';
import { applyDocumentLanguage, t } from './i18n.js';
import { $main, trackRoute, nav } from './ui.js';
import { h, fill, toast } from './dom.js';
import { renderGroup, renderSearch } from './views/library.js';
import { renderTechnique } from './views/technique.js';
import { renderTechniqueEditor, renderGroupEditor } from './views/editors.js';
import { renderImport, renderLink, renderAppOnly, setPendingLink } from './views/import.js';
import { renderMore, renderProfile } from './views/more.js';
import { renderQr, renderYouTube } from './views/sharescreens.js';
import { renderDrive } from './views/drivescreen.js';
import { renderMap } from './views/map.js';
import { renderGraph, leaveGraph, libraryLayout, lastGraphScope } from './graph/view.js';

function route() {
  const hash = location.hash || '#/';

  // Links made by the app, arriving here directly.
  const token = /^#(t1\.[A-Za-z0-9_-]+)/.exec(hash);
  if (token) { nav(`/link/${token[1]}`, { replace: true }); return; }
  if (/^#s1\./.test(hash)) { renderAppOnly('send'); return; }
  if (/^#d1\./.test(hash)) { setPendingLink(location.href); nav('/import', { replace: true }); return; }

  trackRoute();
  leaveGraph();
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  const [a, b, c] = parts;
  try {
    // The Library tab opens the way it was last looked at: list or graph.
    if (!a) return libraryLayout() === 'GRAPH' ? renderGraph(lastGraphScope() || 'all') : renderGroup(null);
    if (a === 'graph') return renderGraph(b || 'all', c || null);
    if (a === 'map' && b) return renderMap(b);
    if (a === 'g' && b && c === 'edit') return renderGroupEditor({ id: b });
    if (a === 'g' && b) return renderGroup(b);
    if (a === 't' && b && c === 'edit') return renderTechniqueEditor({ id: b });
    if (a === 't' && b) return renderTechnique(b);
    if (a === 'new' && b === 't') return renderTechniqueEditor({ inGroup: c || 'root' });
    if (a === 'new' && b === 'g') return renderGroupEditor({ inGroup: c || 'root' });
    if (a === 'import') return renderImport(b || null);
    if (a === 'link' && b) return renderLink(b);
    if (a === 'search') return renderSearch();
    if (a === 'more') return renderMore();
    if (a === 'profile') return renderProfile();
    if (a === 'qr' && b) return renderQr(b);
    if (a === 'drive' && b) return renderDrive(b, c || null);
    if (a === 'youtube' && b) return renderYouTube(b);
    return nav('/', { replace: true });
  } catch (e) {
    console.error(e);
    fill($main(), h('div', { class: 'card error-box' }, h('p', {}, (e && e.message) || String(e))));
  }
}

async function boot() {
  applyDocumentLanguage();
  try {
    await load();
  } catch (e) {
    fill($main(), h('div', { class: 'card error-box' },
      h('h2', {}, t('boot.noStorageTitle')),
      h('p', {}, t('boot.noStorageBody')),
      h('p', { class: 'small muted' }, (e && e.message) || String(e))));
    return;
  }

  // ?open=<package link>: hand it to the import screen and drop it from the address.
  const params = new URLSearchParams(location.search);
  const open = params.get('open');
  if (open) {
    setPendingLink(open);
    history.replaceState(null, '', `${location.pathname}#/import`);
  }

  window.addEventListener('hashchange', route);
  route();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        // A new version finished installing while an old one controls the page.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          const bar = document.getElementById('update');
          bar.hidden = false;
          bar.replaceChildren(
            h('span', {}, t('boot.updateReady')),
            h('button', { class: 'text-btn', type: 'button', onclick: () => worker.postMessage('skipWaiting') }, t('boot.updateNow')));
        }
      });
    });
  }).catch(() => { /* offline support is a bonus */ });
  // Reload only when a NEW version takes over, not when the first one starts controlling the page.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(String((e.reason && e.reason.message) || e.reason), 6000);
});

boot();
