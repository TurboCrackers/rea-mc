'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ffmpeg = require('./ffmpeg');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp'];

// Facts about each imported file, as read by ffmpeg. The window refers to media by id.
const media = new Map();
const running = new Set();
let mainWindow = null;
let exportJob = null;
let proxyDir = null;
let exportFolder = null;

// Progress can arrive after the window has closed.
function notify(sender, channel, data) {
  if (!sender.isDestroyed()) sender.send(channel, data);
}

function track(child) {
  running.add(child);
  child.on('close', () => running.delete(child));
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#17181c',
    title: 'Simple Video Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Dropping a file outside the drop zones must not navigate away from the editor.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('pick-videos', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add videos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Videos', extensions: VIDEO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('import-video', async (_event, filePath) => {
  try {
    const probe = await ffmpeg.run(['-hide_banner', '-nostdin', '-i', filePath], { track });
    const info = ffmpeg.parseProbe(probe.stderr);
    const thumb = await ffmpeg.run(ffmpeg.buildThumbnailArgs(filePath, Math.min(1, info.duration / 3)), { track });
    const id = crypto.randomUUID();
    media.set(id, { path: filePath, ...info });
    return {
      ok: true,
      media: {
        id,
        name: path.basename(filePath),
        path: filePath,
        url: pathToFileURL(filePath).href,
        thumbnail: thumb.stdout.length ? `data:image/jpeg;base64,${thumb.stdout.toString('base64')}` : null,
        ...info,
      },
    };
  } catch (error) {
    return { ok: false, error: `${path.basename(filePath)}: ${error.message}` };
  }
});

// Makes a previewable copy of a file the built-in player can't decode.
ipcMain.handle('make-proxy', async (event, id) => {
  const source = media.get(id);
  if (!source) return { ok: false, error: 'Unknown video.' };
  proxyDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'simple-video-editor-'));
  const target = path.join(proxyDir, `${id}.mp4`);
  const result = await ffmpeg.run(ffmpeg.buildProxyArgs(source.path, target), {
    track,
    onSeconds: (seconds) => notify(event.sender, 'proxy-progress', { id, ratio: seconds / source.duration }),
  });
  if (result.code !== 0) return { ok: false, error: ffmpeg.lastLines(result.stderr, 2) };
  return { ok: true, url: pathToFileURL(target).href };
});

ipcMain.handle('choose-export-path', async () => {
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: 'Export video',
    defaultPath: path.join(exportFolder ?? app.getPath('videos'), 'My video.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  exportFolder = path.dirname(choice.filePath);
  return choice.filePath;
});

// plan: { outPath, resolution, quality, segments: [{ type: 'clip', mediaId, in, out } | { type: 'gap', duration }] }
ipcMain.handle('export-video', async (event, plan) => {
  if (exportJob) return { ok: false, error: 'An export is already running.' };
  let segments;
  try {
    segments = resolveSegments(plan.segments);
    if (typeof plan.outPath !== 'string' || !path.isAbsolute(plan.outPath)) throw new Error('Choose where to save first.');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const first = media.get(plan.segments.find((segment) => segment.type === 'clip').mediaId);
  const outPath = plan.outPath;
  const total = segments.reduce((sum, s) => sum + (s.type === 'clip' ? s.out - s.in : s.duration), 0);
  const format = { ...ffmpeg.outputFormat(first, plan.resolution), quality: plan.quality };
  exportJob = { canceled: false, child: null };
  try {
    const result = await ffmpeg.run(ffmpeg.buildExportArgs(segments, format, outPath), {
      track: (child) => {
        track(child);
        exportJob.child = child;
      },
      onSeconds: (seconds) => notify(event.sender, 'export-progress', { ratio: Math.min(1, seconds / total) }),
    });
    if (exportJob.canceled || result.code !== 0) {
      fs.rmSync(outPath, { force: true });
      return exportJob.canceled
        ? { ok: false, canceled: true }
        : { ok: false, error: ffmpeg.lastLines(result.stderr) };
    }
    return { ok: true, path: outPath };
  } finally {
    exportJob = null;
  }
});

ipcMain.handle('cancel-export', () => {
  if (!exportJob) return;
  exportJob.canceled = true;
  exportJob.child?.kill();
});

ipcMain.handle('show-in-folder', (_event, filePath) => shell.showItemInFolder(filePath));

// Turns the window's plan into ffmpeg segments using the facts read at import.
function resolveSegments(planned) {
  if (!Array.isArray(planned) || !planned.some((segment) => segment?.type === 'clip')) {
    throw new Error('Add at least one video to the timeline first.');
  }
  return planned.map((segment) => {
    if (segment.type === 'gap') {
      if (!(segment.duration > 0 && Number.isFinite(segment.duration))) throw new Error('Invalid gap.');
      return { type: 'gap', duration: segment.duration };
    }
    const source = media.get(segment.mediaId);
    const valid = source && segment.in >= 0 && segment.out > segment.in && segment.out <= source.duration + 0.001;
    if (!valid) throw new Error('A clip on the timeline points outside its video.');
    return { type: 'clip', path: source.path, in: segment.in, out: segment.out, hasAudio: source.hasAudio };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  for (const child of running) child.kill();
  if (proxyDir) {
    try {
      fs.rmSync(proxyDir, { recursive: true, force: true });
    } catch {
      // A preview copy still in use stays in the temp folder; Windows cleans it up later.
    }
  }
});
