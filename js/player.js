/**
 * Full-screen media viewer with the app's study tools: speed (1× → 0.5× → 0.25×), mirror and an
 * A-B loop (tap once for the start, again for the end, again to clear).
 *
 * The controls are our own rather than the browser's: mirroring flips only the picture, and the
 * native controls would be flipped with it (the app hit the same thing — MirroredControls).
 * Speed and mirror carry over between clips; a loop belongs to the clip it was set on.
 */
import { h, icon, iconButton } from './dom.js';
import { t, isRtl } from './i18n.js';
import { urlFor, pin, unpin } from './media.js';

const SPEEDS = [1, 0.5, 0.25];

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let current = null;

/**
 * items: [{ media, title? }]. options.playlist: advance to the next clip when one ends.
 */
export function openPlayer(items, startIndex = 0, options = {}) {
  if (current) current.close(true);
  if (!items.length) return;

  const state = { index: Math.max(0, Math.min(startIndex, items.length - 1)), speed: 1, mirrored: false, loop: null };
  const pinnedKeys = new Set();

  const caption = h('span', { class: 'pl-caption', dir: 'auto' });
  const prevBtn = iconButton('prev', t('player.previous'), () => go(-1));
  const nextBtn = iconButton('next', t('player.next'), () => go(1));
  const stage = h('div', { class: 'pl-stage' });

  const playBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('player.play'), onclick: () => togglePlay() }, icon('play'));
  const timeNow = h('span', { class: 'pl-time' }, '0:00');
  const timeEnd = h('span', { class: 'pl-time' }, '0:00');
  const seek = h('input', { type: 'range', class: 'pl-seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': t('player.seek') });
  const loopMarks = h('div', { class: 'pl-loopmarks' });
  const seekWrap = h('div', { class: 'pl-seekwrap' }, loopMarks, seek);
  const speedBtn = h('button', { class: 'pl-chip', type: 'button', onclick: () => cycleSpeed() }, '1×');
  const mirrorBtn = h('button', { class: 'pl-chip', type: 'button', 'aria-pressed': 'false', onclick: () => toggleMirror() }, icon('mirror', 18), t('player.mirror'));
  const loopBtn = h('button', { class: 'pl-chip', type: 'button', onclick: () => tapLoop() }, icon('loop', 18), h('span', {}, t('player.loop')));
  const videoBar = h('div', { class: 'pl-controls' },
    h('div', { class: 'pl-row' }, playBtn, timeNow, seekWrap, timeEnd),
    h('div', { class: 'pl-row pl-study' }, speedBtn, mirrorBtn, loopBtn));

  const root = h('div', { class: 'player', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('player.title') },
    h('div', { class: 'pl-bar' }, iconButton('close', t('common.close'), () => close()), caption, h('span', { class: 'spacer' }), prevBtn, nextBtn),
    stage,
    videoBar);
  document.body.append(root);
  document.body.classList.add('no-scroll');

  let video = null;
  let raf = 0;
  let seeking = false;

  function setPlayIcon() {
    const playing = video && !video.paused && !video.ended;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', playing ? t('player.pause') : t('player.play'));
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  function cycleSpeed() {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
    applyStudy();
  }

  function toggleMirror() {
    state.mirrored = !state.mirrored;
    applyStudy();
  }

  function tapLoop() {
    if (!video) return;
    const now = video.currentTime;
    if (state.loop == null) state.loop = { start: now, end: null };
    else if (state.loop.end == null) {
      if (Math.abs(now - state.loop.start) < 0.3) return; // same moment twice: wait for a real end
      state.loop = { start: Math.min(now, state.loop.start), end: Math.max(now, state.loop.start) };
      video.currentTime = state.loop.start;
      video.play().catch(() => {});
    } else state.loop = null;
    applyStudy();
  }

  function applyStudy() {
    speedBtn.textContent = `${state.speed}×`;
    speedBtn.classList.toggle('on', state.speed !== 1);
    mirrorBtn.classList.toggle('on', state.mirrored);
    mirrorBtn.setAttribute('aria-pressed', String(state.mirrored));
    const label = state.loop == null ? t('player.loop') : state.loop.end == null ? t('player.loopEnd') : t('player.loopClear');
    loopBtn.lastChild.textContent = label;
    loopBtn.classList.toggle('on', state.loop != null);
    if (video) {
      video.playbackRate = state.speed;
      video.defaultPlaybackRate = state.speed;
      video.style.transform = state.mirrored ? 'scaleX(-1)' : '';
    }
    drawLoopMarks();
  }

  function drawLoopMarks() {
    loopMarks.replaceChildren();
    if (!video || !state.loop || !video.duration) return;
    const d = video.duration;
    const a = (state.loop.start / d) * 100;
    if (state.loop.end == null) {
      loopMarks.append(h('i', { class: 'pl-mark', style: { left: `${a}%` } }));
    } else {
      const b = (state.loop.end / d) * 100;
      loopMarks.append(h('i', { class: 'pl-range', style: { left: `${a}%`, width: `${Math.max(0.5, b - a)}%` } }));
    }
  }

  function tickLoop() {
    raf = 0;
    if (!video) return;
    if (state.loop && state.loop.end != null && video.currentTime >= state.loop.end) {
      video.currentTime = state.loop.start;
    }
    if (!seeking && video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    timeNow.textContent = fmt(video.currentTime);
    if (!video.paused) raf = requestAnimationFrame(tickLoop);
  }

  seek.addEventListener('input', () => {
    seeking = true;
    if (video && video.duration) {
      video.currentTime = (Number(seek.value) / 1000) * video.duration;
      timeNow.textContent = fmt(video.currentTime);
    }
  });
  seek.addEventListener('change', () => { seeking = false; });

  async function show() {
    const item = items[state.index];
    const m = item.media;
    state.loop = null;
    caption.textContent = `${state.index + 1}/${items.length} · ${item.title || m.fileName}`;
    prevBtn.hidden = items.length < 2;
    nextBtn.hidden = items.length < 2;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    video = null;
    stage.replaceChildren(h('p', { class: 'pl-msg' }, t('common.loading')));
    videoBar.hidden = m.type !== 'VIDEO';

    pin(m.blobKey);
    pinnedKeys.add(m.blobKey);
    const url = await urlFor(m.blobKey);
    if (items[state.index] !== item || !root.isConnected) return;
    if (!url) { stage.replaceChildren(h('p', { class: 'pl-msg' }, t('player.missing'))); return; }

    if (m.type === 'VIDEO') {
      video = h('video', { src: url, playsinline: true, autoplay: true, preload: 'auto' });
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.addEventListener('loadedmetadata', () => {
        timeEnd.textContent = fmt(video.duration);
        applyStudy();
      });
      video.addEventListener('play', () => { setPlayIcon(); if (!raf) raf = requestAnimationFrame(tickLoop); });
      video.addEventListener('pause', setPlayIcon);
      video.addEventListener('timeupdate', () => { if (!raf) tickLoop(); });
      video.addEventListener('ended', () => {
        setPlayIcon();
        if (options.playlist && state.index < items.length - 1) go(1);
      });
      video.addEventListener('error', () => {
        stage.replaceChildren(h('p', { class: 'pl-msg' }, t('player.cantPlay')));
      });
      video.addEventListener('click', togglePlay);
      stage.replaceChildren(video);
      applyStudy();
      setPlayIcon();
      // iOS refuses autoplay with sound once the tap that opened us is "used up": stay paused.
      video.play().catch(() => setPlayIcon());
    } else if (m.type === 'IMAGE') {
      stage.replaceChildren(h('img', { src: url, alt: m.fileName }));
    } else {
      stage.replaceChildren(h('div', { class: 'pl-doc' },
        icon('doc', 48),
        h('p', {}, m.fileName),
        h('a', { class: 'btn', href: url, download: m.fileName, target: '_blank', rel: 'noopener' }, t('player.openFile'))));
    }
  }

  function go(step) {
    if (items.length < 2) return;
    state.index = (state.index + step + items.length) % items.length;
    show();
  }

  // Swipe between items (outside the seek bar).
  let touch = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    // Swiping toward the start of the line brings the next item (from the right in Hebrew).
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go((dx < 0) !== isRtl ? 1 : -1);
  });

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(isRtl ? 1 : -1);
    else if (e.key === 'ArrowRight') go(isRtl ? -1 : 1);
    else if (e.key === ' ' && video) { e.preventDefault(); togglePlay(); }
  };
  document.addEventListener('keydown', onKey);

  // The back gesture / button closes the player instead of leaving the page.
  history.pushState({ player: true }, '');
  const onPop = () => close(true);
  window.addEventListener('popstate', onPop);

  function close(fromHistory) {
    if (!root.isConnected) return;
    if (raf) cancelAnimationFrame(raf);
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    root.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    for (const k of pinnedKeys) unpin(k);
    current = null;
    if (!fromHistory && history.state && history.state.player) history.back();
  }

  current = { close };
  show();
  return current;
}
