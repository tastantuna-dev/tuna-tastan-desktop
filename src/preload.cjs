// Controlled bridge: only these exact functions/channels are reachable from
// the renderer. No ipcRenderer object is ever exposed directly, so the
// remote page can never send/listen on an arbitrary channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tunaDesktop', Object.freeze({
  platform: process.platform,
  desktop: true,
  version: process.env.npm_package_version || '2.0.0',

  // Renderer-side error/info reports get appended to the main-process log
  // file so issues reported from the app are visible in diagnostics.
  logInfo: (message) => ipcRenderer.send('renderer-log', { level: 'info', message: String(message) }),
  logError: (message) => ipcRenderer.send('renderer-log', { level: 'error', message: String(message) }),

  // Standalone auth/data bridge. The main process only honors these calls
  // when they come from the app://tuna origin (see assertAppSender in
  // main.cjs) - exposing them here does not by itself grant anything else
  // access.
  standalone: Object.freeze({
    getConfig: () => ipcRenderer.invoke('standalone-config:get'),
    authStorage: Object.freeze({
      getItem: (key) => ipcRenderer.invoke('auth-storage:get', key),
      setItem: (key, value) => ipcRenderer.invoke('auth-storage:set', key, value),
      removeItem: (key) => ipcRenderer.invoke('auth-storage:remove', key),
    }),
  }),
}));
