const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('researchDesk', {
  run: (command) => ipcRenderer.send('research:run', command),
  on: (channel, listener) => {
    const allowed = ['research:started', 'research:stage', 'research:completed', 'research:error', 'research:notice'];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  testConnection: (params) => ipcRenderer.invoke('settings:test', params),
  listModels: (params) => ipcRenderer.invoke('models:list', params),

  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  getCache: () => ipcRenderer.invoke('cache:get'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),

  openExternal: (url) => ipcRenderer.send('external:open', url)
});
