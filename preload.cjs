'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  const handler = (_, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('desk', {
  initial: () => ipcRenderer.invoke('desk:initial'),
  chooseRepository: () => ipcRenderer.invoke('desk:choose-repository'),
  snapshot: (mode, ref) => ipcRenderer.invoke('desk:snapshot', mode, ref),
  patch: fileId => ipcRenderer.invoke('desk:patch', fileId),
  setDocked: enabled => ipcRenderer.invoke('desk:dock', enabled),
  setCollapsed: collapsed => ipcRenderer.invoke('desk:collapse', collapsed),
  dragBall: phase => ipcRenderer.invoke('desk:drag-ball', phase),
  settings: () => ipcRenderer.invoke('desk:settings'),
  setSetting: (key, value) => ipcRenderer.invoke('desk:set-setting', key, value),
  setOutsideEdge: (edge, inside) => ipcRenderer.invoke('desk:outside-edge', edge, inside),
  closeWindow: () => ipcRenderer.invoke('desk:close'),
  tree: (directory = '') => ipcRenderer.invoke('desk:tree', directory),
  readFile: relative => ipcRenderer.invoke('desk:read-file', relative),
  searchFiles: query => ipcRenderer.invoke('desk:search-files', query),
  startReview: () => ipcRenderer.invoke('desk:start-review'),
  cancelReview: () => ipcRenderer.invoke('desk:cancel-review'),
  copy: text => ipcRenderer.invoke('desk:copy', text),
  onReviewUpdate: callback => listen('desk:review-update', callback),
  onRepositoryChanged: callback => listen('desk:repository-changed', callback),
  onProjectActivity: callback => listen('desk:project-activity', callback),
  onDockChanged: callback => listen('desk:dock-changed', callback),
  onCollapsedChanged: callback => listen('desk:collapsed-changed', callback),
});
