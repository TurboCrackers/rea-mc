import * as timeline from './timeline.js';
import { Player } from './player.js';

const editor = window.editor;
const $ = (id) => document.getElementById(id);

const MEDIA_DRAG = 'application/x-simple-video-editor-media';
const DRAG_THRESHOLD = 4;
const FRAME = 1 / 30;
const MIN_ZOOM = 2;
const MAX_ZOOM = 400;
const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const UNDO_LIMIT = 100;

const state = {
  items: [],
  media: new Map(),
  selectedId: null,
  pixelsPerSecond: 50,
  autoFit: true,
  fitLocked: false,
  past: [],
  future: [],
};

const player = new Player({
  screens: [$('screen-a'), $('screen-b')],
  message: $('stage-message'),
  getItems: () => state.items,
  getMedia: (id) => state.media.get(id),
  onTime: updatePlayhead,
  onPlayingChange: (playing) => {
    $('play').textContent = playing ? '❚❚' : '▶';
  },
});

// ---------- Editing and history ----------

function commit(items, { select } = {}) {
  player.pause();
  state.past.push(state.items);
  if (state.past.length > UNDO_LIMIT) state.past.shift();
  state.future = [];
  if (select !== undefined) state.selectedId = select;
  setItems(items);
}

function setItems(items) {
  state.items = items;
  if (!items.some((item) => item.id === state.selectedId)) state.selectedId = null;
  renderTimeline();
  player.seek(player.time);
}

function undo() {
  if (!state.past.length) return;
  player.pause();
  state.future.push(state.items);
  setItems(state.past.pop());
}

function redo() {
  if (!state.future.length) return;
  player.pause();
  state.past.push(state.items);
  setItems(state.future.pop());
}

function select(id) {
  state.selectedId = id;
  renderTimeline();
}

function selectedItem() {
  return state.items.find((item) => item.id === state.selectedId) ?? null;
}

function splitAtPlayhead() {
  const result = timeline.split(state.items, player.time);
  if (!result) {
    showToast('Move the red line onto a clip to split it.', 'info');
    return;
  }
  commit(result.items, { select: result.right.id });
}

function deleteSelected(closeGap) {
  const item = selectedItem();
  if (!item) return;
  const items = closeGap ? timeline.removeAndClose(state.items, item.id) : timeline.remove(state.items, item.id);
  commit(items, { select: null });
}

function addToTimeline(mediaList, time) {
  if (!mediaList.length) return;
  let items = state.items;
  let at = time;
  let last = null;
  for (const media of mediaList) {
    last = { type: 'clip', id: timeline.newId(), mediaId: media.id, in: 0, out: media.duration };
    items = timeline.insert(items, last, at);
    at = timeline.layout(items).find((item) => item.id === last.id).end;
  }
  commit(items, { select: last.id });
}

// ---------- Importing ----------

async function addVideos() {
  const paths = await editor.pickVideos();
  await importAndPlace(paths);
}

// The first videos go straight onto the empty timeline; later ones wait in the library.
async function importAndPlace(paths) {
  const added = await importPaths(paths);
  if (!state.items.length) addToTimeline(added, Infinity);
}

async function importPaths(paths) {
  const added = [];
  const errors = [];
  for (const path of paths) {
    const known = [...state.media.values()].find((media) => media.path.toLowerCase() === path.toLowerCase());
    if (known) {
      added.push(known);
      continue;
    }
    showToast(`Adding ${path.split(/[\\/]/).pop()}…`, 'info', 0);
    const result = await editor.importVideo(path);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    const media = { ...result.media, previewUrl: null, status: 'Checking…' };
    state.media.set(media.id, media);
    added.push(media);
    renderLibrary();
    preparePreview(media);
  }
  if (errors.length) showToast(errors.join('\n'));
  else hideToast();
  updateButtons();
  return added;
}

// Most videos play directly. Others (AVI, WMV, ...) get a preview copy; export
// always uses the original file.
async function preparePreview(media) {
  if (await canPlay(media.url)) {
    media.previewUrl = media.url;
    media.status = '';
  } else {
    setMediaStatus(media, 'Preparing preview…');
    const result = await editor.makeProxy(media.id);
    media.previewUrl = result.ok ? result.url : null;
    media.status = result.ok ? '' : 'No preview for this format (export still works)';
  }
  renderLibrary();
  if (!player.playing) player.seek(player.time);
}

function canPlay(url) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'auto';
    const finish = (playable) => {
      clearTimeout(timer);
      probe.removeAttribute('src');
      probe.load();
      resolve(playable);
    };
    const timer = setTimeout(() => finish(false), 10000);
    probe.addEventListener('loadeddata', () => finish(probe.videoWidth > 0), { once: true });
    probe.addEventListener('error', () => finish(false), { once: true });
    probe.src = url;
  });
}

function setMediaStatus(media, status) {
  media.status = status;
  const node = $('media-list').querySelector(`[data-id="${media.id}"] .status`);
  if (node) node.textContent = status;
  else renderLibrary();
}

editor.onProxyProgress(({ id, ratio }) => {
  const media = state.media.get(id);
  if (media && !media.previewUrl) setMediaStatus(media, `Preparing preview… ${Math.round(Math.min(1, ratio) * 100)}%`);
});

function droppedPaths(dataTransfer) {
  return [...dataTransfer.files].map((file) => editor.pathForFile(file)).filter(Boolean);
}

// ---------- Rendering ----------

function renderLibrary() {
  const list = $('media-list');
  list.replaceChildren();
  for (const media of state.media.values()) {
    const node = el('div', 'media');
    node.draggable = true;
    node.dataset.id = media.id;
    node.title = `${media.path}\nDrag onto the timeline, or double-click to add it to the end.`;
    const thumb = media.thumbnail ? Object.assign(el('img'), { src: media.thumbnail, alt: '' }) : el('div', 'no-thumb');
    const meta = el('div', 'meta');
    meta.append(el('div', 'name', media.name), el('div', 'info', describe(media)), el('div', 'status', media.status));
    const add = el('button', '', '+');
    add.title = 'Add to the end of the timeline';
    add.dataset.action = 'append';
    node.append(thumb, meta, add);
    list.append(node);
  }
  $('library-hint').textContent = state.media.size
    ? 'Drag a video onto the timeline below, or double-click it to add it to the end.'
    : 'Videos you add will show up here.';
  updateButtons();
}

function renderTimeline(items = state.items) {
  const scroll = $('timeline-scroll');
  const available = scroll.clientWidth - 24;
  const total = timeline.totalDuration(items);
  // Leave room after the last clip to drop more videos.
  const room = 80;
  if (state.autoFit && !state.fitLocked) {
    state.pixelsPerSecond = clamp((available - room) / Math.max(total, 10), MIN_ZOOM, MAX_ZOOM);
  }
  const pps = state.pixelsPerSecond;
  const width = Math.max(available, total * pps + room);
  $('timeline').style.width = `${width}px`;
  renderRuler(width, pps);

  const track = $('track');
  track.replaceChildren();
  if (!items.length) track.append(el('div', 'empty-track', 'Drag videos here'));
  for (const item of timeline.layout(items)) {
    track.append(item.type === 'clip' ? clipNode(item, pps) : gapNode(item, pps));
  }
  updatePlayhead(player.time);
  updateButtons();
}

function renderRuler(width, pps) {
  const step = TICK_STEPS.find((candidate) => candidate * pps >= 70) ?? TICK_STEPS.at(-1);
  const ruler = $('ruler');
  ruler.replaceChildren();
  for (let i = 0; i * step * pps < width; i++) {
    const tick = el('div', 'tick', formatClock(i * step, step < 1));
    tick.style.left = `${i * step * pps}px`;
    ruler.append(tick);
  }
}

function clipNode(item, pps) {
  const media = state.media.get(item.mediaId);
  const node = el('div', 'clip');
  node.dataset.id = item.id;
  node.classList.toggle('selected', item.id === state.selectedId);
  place(node, item, pps);
  if (media.thumbnail) node.style.backgroundImage = `url("${media.thumbnail}")`;
  node.title = `${media.name}\nUsing ${formatClock(item.in)} to ${formatClock(item.out)} of the original`;
  const start = el('div', 'handle start');
  start.dataset.edge = 'start';
  start.title = 'Drag to trim the start';
  const end = el('div', 'handle end');
  end.dataset.edge = 'end';
  end.title = 'Drag to trim the end';
  node.append(start, el('span', 'label', media.name), el('span', 'length', formatLength(item.out - item.in)), end);
  return node;
}

function gapNode(item, pps) {
  const node = el('div', 'gap');
  node.dataset.id = item.id;
  node.classList.toggle('selected', item.id === state.selectedId);
  node.title = 'A gap plays as black with no sound. Drop a video here to fill it.';
  place(node, item, pps);
  const close = el('button', 'close-gap', '✕');
  close.title = 'Close this gap';
  node.append(el('span', '', `Gap ${formatLength(item.duration)}`), close);
  return node;
}

function place(node, item, pps) {
  node.style.left = `${item.start * pps}px`;
  node.style.width = `${Math.max(2, (item.end - item.start) * pps)}px`;
}

function updatePlayhead(time) {
  const pps = state.pixelsPerSecond;
  $('playhead').style.transform = `translateX(${time * pps}px)`;
  $('clock').textContent = `${formatClock(time)} / ${formatClock(timeline.totalDuration(state.items))}`;
  $('split').disabled = !timeline.canSplit(state.items, time);
  if (player.playing) {
    const scroll = $('timeline-scroll');
    const x = time * pps;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = x - 40;
  }
}

function updateButtons() {
  const selected = selectedItem();
  $('delete').disabled = selected?.type !== 'clip';
  $('delete-close').disabled = !selected;
  $('undo').disabled = !state.past.length;
  $('redo').disabled = !state.future.length;
  $('export').disabled = !state.items.some((item) => item.type === 'clip');
  $('empty-state').hidden = state.media.size > 0;
  $('tip').textContent = !state.items.length
    ? ''
    : selected?.type === 'gap'
      ? 'Drop a video onto the gap to fill it, or close it.'
      : selected?.type === 'clip'
        ? 'Drag the clip edges to trim. Drag the clip to move it.'
        : 'Click a clip to select it. Press S to split it at the red line.';
}

function showDropTarget(items, time) {
  const point = timeline.insertionPoint(items, time);
  const marker = $('drop-marker');
  marker.hidden = false;
  marker.style.left = `${point.time * state.pixelsPerSecond}px`;
  const under = timeline.itemAt(items, time);
  for (const node of $('track').querySelectorAll('.gap')) {
    node.classList.toggle('drop-target', under?.type === 'gap' && node.dataset.id === under.id);
  }
}

function hideDropTarget() {
  $('drop-marker').hidden = true;
  for (const node of $('track').querySelectorAll('.drop-target')) node.classList.remove('drop-target');
}

// ---------- Timeline mouse handling ----------

let drag = null;

function timeAt(event) {
  return Math.max(0, (event.clientX - $('timeline').getBoundingClientRect().left) / state.pixelsPerSecond);
}

function startScrub(event) {
  player.seek(timeAt(event));
  drag = { move: (e) => player.seek(timeAt(e)) };
}

function startTrim(event, id, edge) {
  player.pause();
  const before = state.items;
  const media = state.media.get(before.find((item) => item.id === id).mediaId);
  const startX = event.clientX;
  state.selectedId = id;
  state.fitLocked = true;
  renderTimeline();
  drag = {
    move(e) {
      const delta = (e.clientX - startX) / state.pixelsPerSecond;
      state.items = timeline.trim(before, id, edge, delta, media.duration);
      renderTimeline();
      // Show the frame at the edge being dragged.
      const clip = timeline.layout(state.items).find((item) => item.id === id);
      player.seek(edge === 'start' ? clip.start : clip.end - FRAME);
    },
    end() {
      state.fitLocked = false;
      const after = state.items;
      state.items = before;
      if (after !== before) commit(after);
      else renderTimeline();
    },
  };
}

function startClipDrag(event, id) {
  const startX = event.clientX;
  const grabbedAt = timeAt(event);
  select(id);
  player.seek(grabbedAt);
  let moving = null;
  drag = {
    move(e) {
      if (!moving) {
        if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
        player.pause();
        state.fitLocked = true;
        const clip = timeline.layout(state.items).find((item) => item.id === id);
        moving = { base: timeline.vacate(state.items, id), offset: grabbedAt - clip.start };
        renderTimeline(moving.base);
        const ghost = $('ghost');
        ghost.hidden = false;
        ghost.style.width = `${(clip.end - clip.start) * state.pixelsPerSecond}px`;
        const thumbnail = state.media.get(clip.mediaId).thumbnail;
        ghost.style.backgroundImage = thumbnail ? `url("${thumbnail}")` : '';
      }
      const time = timeAt(e);
      $('ghost').style.left = `${(time - moving.offset) * state.pixelsPerSecond}px`;
      showDropTarget(moving.base, time);
    },
    end(e) {
      if (!moving) return;
      finishMove();
      commit(timeline.move(state.items, id, timeAt(e)), { select: id });
    },
    cancel() {
      if (!moving) return;
      finishMove();
      renderTimeline();
    },
  };
}

function finishMove() {
  $('ghost').hidden = true;
  hideDropTarget();
  state.fitLocked = false;
}

function setupTimeline() {
  const node = $('timeline');
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.close-gap')) return;
    node.setPointerCapture(event.pointerId);
    const clip = event.target.closest('.clip');
    const handle = event.target.closest('.handle');
    if (clip && handle) return startTrim(event, clip.dataset.id, handle.dataset.edge);
    if (clip) return startClipDrag(event, clip.dataset.id);
    select(event.target.closest('.gap')?.dataset.id ?? null);
    startScrub(event);
  });
  node.addEventListener('pointermove', (event) => drag?.move(event));
  node.addEventListener('pointerup', (event) => {
    drag?.end?.(event);
    drag = null;
  });
  node.addEventListener('pointercancel', () => {
    drag?.cancel?.();
    drag = null;
  });
  node.addEventListener('click', (event) => {
    const gap = event.target.closest('.close-gap')?.closest('.gap');
    if (gap) commit(timeline.removeAndClose(state.items, gap.dataset.id), { select: null });
  });

  // Videos dragged from the library or from File Explorer.
  node.addEventListener('dragover', (event) => {
    const types = event.dataTransfer.types;
    if (!types.includes(MEDIA_DRAG) && !types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    showDropTarget(state.items, timeAt(event));
  });
  node.addEventListener('dragleave', (event) => {
    if (!node.contains(event.relatedTarget)) hideDropTarget();
  });
  node.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.remove('dragging-files');
    hideDropTarget();
    const time = timeAt(event);
    const mediaId = event.dataTransfer.getData(MEDIA_DRAG);
    if (mediaId) addToTimeline([state.media.get(mediaId)], time);
    else addToTimeline(await importPaths(droppedPaths(event.dataTransfer)), time);
  });

  const scroll = $('timeline-scroll');
  scroll.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (!event.ctrlKey) {
        scroll.scrollLeft += event.deltaY + event.deltaX;
        return;
      }
      const time = timeAt(event);
      const offset = event.clientX - scroll.getBoundingClientRect().left;
      zoom(event.deltaY < 0 ? 1.25 : 0.8);
      scroll.scrollLeft = time * state.pixelsPerSecond - offset + 12;
    },
    { passive: false },
  );
}

function zoom(factor) {
  state.autoFit = false;
  state.pixelsPerSecond = clamp(state.pixelsPerSecond * factor, MIN_ZOOM, MAX_ZOOM);
  renderTimeline();
}

// ---------- Library, window drops, buttons and keys ----------

function setupLibrary() {
  const list = $('media-list');
  list.addEventListener('dragstart', (event) => {
    const node = event.target.closest('.media');
    if (!node) return;
    event.dataTransfer.setData(MEDIA_DRAG, node.dataset.id);
    event.dataTransfer.effectAllowed = 'copy';
  });
  const append = (event) => {
    const node = event.target.closest('.media');
    if (node) addToTimeline([state.media.get(node.dataset.id)], Infinity);
  };
  list.addEventListener('dblclick', append);
  list.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="append"]')) append(event);
  });

  // Files dropped anywhere else are added to the library.
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer.types.includes('Files')) document.body.classList.add('dragging-files');
  });
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) document.body.classList.remove('dragging-files');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('dragging-files');
    const paths = droppedPaths(event.dataTransfer);
    if (paths.length) importAndPlace(paths);
  });
}

function setupButtons() {
  $('add').addEventListener('click', addVideos);
  $('play').addEventListener('click', () => player.toggle());
  $('to-start').addEventListener('click', () => player.seek(0));
  $('split').addEventListener('click', splitAtPlayhead);
  $('delete').addEventListener('click', () => deleteSelected(false));
  $('delete-close').addEventListener('click', () => deleteSelected(true));
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zoom-in').addEventListener('click', () => zoom(1.5));
  $('zoom-out').addEventListener('click', () => zoom(1 / 1.5));
  $('zoom-fit').addEventListener('click', () => {
    state.autoFit = true;
    renderTimeline();
  });
  $('export').addEventListener('click', openExport);
  // Keep keyboard shortcuts working after clicking a button.
  document.addEventListener('pointerup', () => {
    const active = document.activeElement;
    if (active?.tagName === 'BUTTON' && !active.closest('dialog')) active.blur();
  });
  window.addEventListener('resize', () => renderTimeline());
}

function setupKeys() {
  window.addEventListener('keydown', (event) => {
    if ($('export-dialog').open || event.target.closest?.('select, input')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const ctrl = event.ctrlKey || event.metaKey;
    if (key === ' ') player.toggle();
    else if (key === 's' && !ctrl) splitAtPlayhead();
    else if (key === 'Delete' || key === 'Backspace') deleteSelected(event.shiftKey);
    else if (ctrl && key === 'z') event.shiftKey ? redo() : undo();
    else if (ctrl && key === 'y') redo();
    else if (key === 'Home') player.seek(0);
    else if (key === 'End') player.seek(timeline.totalDuration(state.items));
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      player.pause();
      const step = event.shiftKey ? 1 : FRAME;
      player.seek(player.time + (key === 'ArrowLeft' ? -step : step));
    } else if (key === 'Escape') select(null);
    else return;
    event.preventDefault();
  });
}

// ---------- Export ----------

function openExport() {
  const first = state.media.get(state.items.find((item) => item.type === 'clip').mediaId);
  player.pause();
  $('export-source-size').textContent = `Same as first clip (${first.width}×${first.height})`;
  $('export-gap-note').hidden = !state.items.some((item) => item.type === 'gap');
  showExportPane('export-settings');
  $('export-dialog').showModal();
}

function showExportPane(id) {
  for (const pane of ['export-settings', 'export-running', 'export-finished']) $(pane).hidden = pane !== id;
}

function setupExport() {
  const dialog = $('export-dialog');
  let savedPath = null;
  $('export-settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (event.submitter?.value !== 'go') {
      dialog.close();
      return;
    }
    const outPath = await editor.chooseExportPath();
    if (!outPath) return;
    showExportPane('export-running');
    setExportProgress(0);
    const result = await editor.exportVideo({
      outPath,
      resolution: $('export-resolution').value,
      quality: $('export-quality').value,
      segments: state.items.map((item) =>
        item.type === 'clip'
          ? { type: 'clip', mediaId: item.mediaId, in: item.in, out: item.out }
          : { type: 'gap', duration: item.duration },
      ),
    });
    if (result.canceled) {
      dialog.close();
      return;
    }
    savedPath = result.ok ? result.path : null;
    $('export-title').textContent = result.ok ? 'Done!' : 'Export failed';
    $('export-result').textContent = result.ok ? `Saved to\n${result.path}` : result.error;
    $('export-show').hidden = !result.ok;
    showExportPane('export-finished');
  });
  // Escape must not hide a running export.
  dialog.addEventListener('cancel', (event) => {
    if (!$('export-running').hidden) event.preventDefault();
  });
  $('export-cancel').addEventListener('click', () => editor.cancelExport());
  $('export-show').addEventListener('click', () => editor.showInFolder(savedPath));
  $('export-close').addEventListener('click', () => dialog.close());
  editor.onExportProgress(({ ratio }) => setExportProgress(ratio));
}

function setExportProgress(ratio) {
  $('export-progress').value = ratio;
  $('export-percent').textContent = `${Math.floor(ratio * 100)}%`;
}

// ---------- Helpers ----------

let toastTimer = null;

function showToast(text, kind = 'error', milliseconds = 6000) {
  const toast = $('toast');
  toast.textContent = text;
  toast.className = kind === 'info' ? 'info' : '';
  toast.hidden = false;
  clearTimeout(toastTimer);
  if (milliseconds) toastTimer = setTimeout(hideToast, milliseconds);
}

function hideToast() {
  $('toast').hidden = true;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function describe(media) {
  return `${formatLength(media.duration)} · ${media.width}×${media.height}${media.hasAudio ? '' : ' · no sound'}`;
}

function formatClock(seconds, tenths = true) {
  const total = Math.floor(seconds * 10 + 1e-6);
  const minutes = Math.floor(total / 600);
  const rest = (total % 600) / 10;
  return tenths ? `${minutes}:${rest.toFixed(1).padStart(4, '0')}` : `${minutes}:${String(Math.floor(rest)).padStart(2, '0')}`;
}

function formatLength(seconds) {
  return seconds < 60 ? `${seconds.toFixed(1)}s` : formatClock(seconds, false);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

setupTimeline();
setupLibrary();
setupButtons();
setupKeys();
setupExport();
renderLibrary();
renderTimeline();
player.seek(0);
