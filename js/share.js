/**
 * Sharing a package or a technique link.
 *
 * Building a package takes a while (every file is read once for its checksum), and iOS only lets
 * a page open the share sheet straight after a tap. So the package is built first, then a dialog
 * offers Share / Save — that tap opens the sheet.
 */
import { h, infoDialog, toast } from './dom.js';
import { t } from './i18n.js';
import { exportPackage } from './packages.js';
import { techniqueViewerLink } from './links.js';
import { formatBytes } from './ui.js';

export async function shareExport(target, includeMedia) {
  const bar = h('progress', { max: 1, value: 0 });
  const status = h('p', {}, t('share.preparing'));
  let cancelled = false;
  let close = infoDialog(
    h('h2', {}, t('share.preparingTitle')), status, bar,
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn tonal', type: 'button', onclick: () => { cancelled = true; close(); } }, t('common.cancel'))));

  let result;
  try {
    result = await exportPackage(target, includeMedia, (doneBytes, total) => {
      bar.max = Math.max(1, total);
      bar.value = doneBytes;
      status.textContent = t('share.progress', { done: formatBytes(doneBytes), total: formatBytes(total) });
    });
  } catch (e) {
    close();
    if (!cancelled) infoError((e && e.message) || String(e));
    return;
  }
  close();
  if (cancelled) return;

  const file = new File([result.blob], result.fileName, { type: 'application/zip' });
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const url = URL.createObjectURL(file);
  const summary = t('share.readySummary', {
    techniques: result.counts.techniques, media: result.counts.media, size: formatBytes(file.size),
  });
  close = infoDialog(
    h('h2', {}, t('share.readyTitle')),
    h('p', {}, result.fileName),
    h('p', { class: 'small muted' }, summary),
    h('div', { class: 'dialog-actions stack' },
      canShareFile ? h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await navigator.share({ files: [file], title: result.fileName });
            close();
          } catch (e) {
            if (e && e.name !== 'AbortError') toast(t('share.shareFailed'));
          }
        },
      }, t('share.share')) : null,
      h('a', { class: `btn${canShareFile ? ' tonal' : ''}`, href: url, download: result.fileName, onclick: () => setTimeout(() => toast(t('share.saved')), 300) }, t('share.save')),
      h('button', { class: 'btn tonal', type: 'button', onclick: () => close() }, t('common.close'))),
    h('p', { class: 'small muted' }, t('share.howToOpen')));
  // Keep the URL until the page goes away: Safari reads the download after the click returns.
}

function infoError(text) {
  let close;
  close = infoDialog(h('h2', {}, t('common.error')), h('p', {}, text),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('common.ok'))));
}

/** Shares (or copies) a text-only technique link. Must run straight from a tap. */
export async function shareTechniqueLink(x) {
  const link = techniqueViewerLink(x);
  if (navigator.share) {
    try {
      await navigator.share({ title: x.name, url: link });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    toast(t('share.linkCopied'));
  } catch {
    const field = h('input', { class: 'field', readonly: true, value: link, onfocus: (e) => e.target.select() });
    let close;
    close = infoDialog(h('h2', {}, t('share.copyThis')), field,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('common.close'))));
  }
}
