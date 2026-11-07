/**
 * Scanning a QR code with the phone's camera (a technique link, a Drive link, any package link).
 *
 * The camera picture is read a few times a second into a small canvas and decoded with jsQR
 * (vendor/jsQR.js, Apache-2.0): Firefox and iPhone Safari have no built-in QR reader, so one
 * decoder works everywhere. Nothing leaves the phone. The camera stops as soon as a code is read
 * or the screen is closed.
 */
import { h, icon, iconButton } from './dom.js';
import { t } from './i18n.js';

const SCAN_EVERY_MS = 180;
const MAX_SIDE = 720;

let decoderPromise = null;
/** jsQR is 250 KB: fetched the first time someone scans (the offline cache keeps it after). */
function loadDecoder() {
  if (globalThis.jsQR) return Promise.resolve();
  if (!decoderPromise) {
    decoderPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsQR.js';
      s.onload = () => resolve();
      s.onerror = () => { decoderPromise = null; reject(new Error('decoder')); };
      document.head.append(s);
    });
  }
  return decoderPromise;
}

/** Opens the scanner; resolves with the text of the first code read, or null if closed. */
export function scanQr() {
  return new Promise((resolve) => {
    const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
    video.setAttribute('playsinline', '');
    video.muted = true;
    const message = h('p', { class: 'scan-msg' }, t('scan.starting'));
    const root = h('div', { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('scan.title') },
      h('div', { class: 'pl-bar' }, iconButton('close', t('common.close'), () => finish(null)), h('span', { class: 'pl-caption' }, t('scan.title'))),
      h('div', { class: 'scan-stage' }, video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' })),
      message);
    document.body.append(root);
    document.body.classList.add('no-scroll');

    let stream = null;
    let timer = 0;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function finish(text) {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (stream) for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      root.remove();
      document.body.classList.remove('no-scroll');
      document.removeEventListener('keydown', onKey);
      resolve(text);
    }
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);

    function tick() {
      if (done || video.readyState < 2 || !video.videoWidth) return;
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale);
      const hh = Math.round(video.videoHeight * scale);
      if (canvas.width !== w) { canvas.width = w; canvas.height = hh; }
      ctx.drawImage(video, 0, 0, w, hh);
      const img = ctx.getImageData(0, 0, w, hh);
      const code = globalThis.jsQR ? globalThis.jsQR(img.data, w, hh, { inversionAttempts: 'attemptBoth' }) : null;
      if (code && code.data) {
        if (navigator.vibrate) { try { navigator.vibrate(40); } catch { /* optional */ } }
        finish(code.data.trim());
      }
    }

    (async () => {
      try { await loadDecoder(); } catch { message.textContent = t('scan.noDecoder'); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        message.textContent = t('scan.noCamera');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        message.textContent = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? t('scan.denied') : t('scan.noCamera');
        return;
      }
      if (done) { for (const track of stream.getTracks()) track.stop(); return; }
      video.srcObject = stream;
      try { await video.play(); } catch { /* autoplay of a muted camera is allowed */ }
      message.textContent = t('scan.aim');
      timer = setInterval(tick, SCAN_EVERY_MS);
    })();
  });
}

/** The Scan button shown on the Import screen. `onText(text)` gets what was read. */
export function scanButton(onText) {
  return h('button', {
    class: 'btn tonal block', type: 'button',
    onclick: async () => { const text = await scanQr(); if (text) onText(text); },
  }, icon('qr', 20), t('scan.button'));
}
