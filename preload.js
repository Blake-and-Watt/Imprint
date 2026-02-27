const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setLastZipName: (name) => ipcRenderer.invoke('set-last-zip-name', name),
  openWatermarkDialog: () => ipcRenderer.invoke('open-watermark-dialog'),
  getWatermarks: () => ipcRenderer.invoke('get-watermarks'),
  deleteWatermark: (id) => ipcRenderer.invoke('delete-watermark', id),
  renameWatermark: (id, name) => ipcRenderer.invoke('rename-watermark', { id, name }),
  saveWatermarkPositions: (id, positions) => ipcRenderer.invoke('save-watermark-positions', { id, positions }),
  getWatermarkPositions: (id) => ipcRenderer.invoke('get-watermark-positions', id),
  processImages: (payload) => ipcRenderer.invoke('process-images', payload),
  saveZip: (data, defaultName) => ipcRenderer.invoke('save-zip', { data, defaultName }),
  readMetadata: (images) => ipcRenderer.invoke('read-metadata', { images }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getSavedValues: () => ipcRenderer.invoke('get-saved-values'),
  saveFieldValue: (fieldKey, value) => ipcRenderer.invoke('save-field-value', { fieldKey, value }),
  deleteSavedValue: (fieldKey, value) => ipcRenderer.invoke('delete-saved-value', { fieldKey, value }),
  confirmDeleteOriginals: (message) => ipcRenderer.invoke('confirm-delete-originals', message),
  deleteOriginals: (paths) => ipcRenderer.invoke('delete-originals', paths),
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),
  saveFilesToFolder: (payload) => ipcRenderer.invoke('save-files-to-folder', payload),
});
