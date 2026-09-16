const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateBootstrap', {
  onState: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('update-bootstrap:state', handler);
    return () => ipcRenderer.removeListener('update-bootstrap:state', handler);
  }
});
