'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('editor', {
  pickVideos: () => ipcRenderer.invoke('pick-videos'),
  importVideo: (filePath) => ipcRenderer.invoke('import-video', filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),
  makeProxy: (mediaId) => ipcRenderer.invoke('make-proxy', mediaId),
  chooseExportPath: () => ipcRenderer.invoke('choose-export-path'),
  exportVideo: (plan) => ipcRenderer.invoke('export-video', plan),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  onProxyProgress: (callback) => ipcRenderer.on('proxy-progress', (_event, data) => callback(data)),
  onExportProgress: (callback) => ipcRenderer.on('export-progress', (_event, data) => callback(data)),
});
