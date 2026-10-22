// Sandboxed preload: may only require 'electron'. Keep imports from local files type-only.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DownloadView, HaulApi, PowerState, ToolInstallStatus } from '../shared/types';

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: HaulApi = {
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  addDownload: (req) => ipcRenderer.invoke('downloads:add', req),
  pause: (id) => ipcRenderer.invoke('downloads:pause', id),
  resume: (id) => ipcRenderer.invoke('downloads:resume', id),
  retry: (id) => ipcRenderer.invoke('downloads:retry', id),
  cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
  changeUrl: (id, url) => ipcRenderer.invoke('downloads:changeUrl', id, url),
  remove: (id, deleteFile) => ipcRenderer.invoke('downloads:remove', id, deleteFile),
  pauseAll: () => ipcRenderer.invoke('downloads:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('downloads:resumeAll'),
  clearFinished: () => ipcRenderer.invoke('downloads:clearFinished'),
  openFile: (id) => ipcRenderer.invoke('downloads:openFile', id),
  showInFolder: (id) => ipcRenderer.invoke('downloads:showInFolder', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  chooseDirectory: (initial) => ipcRenderer.invoke('dialog:chooseDirectory', initial),
  chooseExecutable: (initial) => ipcRenderer.invoke('dialog:chooseExecutable', initial),
  probeMedia: (url) => ipcRenderer.invoke('media:probe', url),
  cancelProbe: () => ipcRenderer.invoke('media:cancelProbe'),
  getMediaTools: () => ipcRenderer.invoke('media:tools'),
  updateMediaTools: () => ipcRenderer.invoke('media:updateTools'),
  onMediaToolsProgress: (cb) => subscribe<ToolInstallStatus>('media:toolsProgress', cb),
  getPower: () => ipcRenderer.invoke('power:get'),
  setShutdownWhenDone: (armed) => ipcRenderer.invoke('power:setShutdownWhenDone', armed),
  onPowerChanged: (cb) => subscribe<PowerState>('power:changed', cb),
  readClipboardUrl: () => ipcRenderer.invoke('clipboard:readUrl'),
  takePendingAddRequests: () => ipcRenderer.invoke('app:takePendingAddRequests'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  onDownloadChanged: (cb) => subscribe<DownloadView>('downloads:changed', cb),
  onDownloadRemoved: (cb) => subscribe<string>('downloads:removed', cb),
  onAddRequest: (cb) => subscribe<string>('app:addRequest', cb),
};

contextBridge.exposeInMainWorld('haul', api);
