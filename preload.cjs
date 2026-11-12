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
  setAlwaysOnTop: enabled => ipcRenderer.invoke('desk:pin', enabled),
  startReview: () => ipcRenderer.invoke('desk:start-review'),
  cancelReview: () => ipcRenderer.invoke('desk:cancel-review'),
  copy: text => ipcRenderer.invoke('desk:copy', text),
  onReviewUpdate: callback => listen('desk:review-update', callback),
  onRepositoryChanged: callback => listen('desk:repository-changed', callback),
});
