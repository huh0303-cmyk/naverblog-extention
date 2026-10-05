const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blogAuto", {
  platform: process.platform,
  openTistoryChrome: blogId => ipcRenderer.invoke('tistory:open',blogId),
  pairTistoryExtension: blogId => ipcRenderer.invoke('tistory:pair',blogId),
  setWindowTheme: theme => ipcRenderer.invoke('window:theme', theme),
  cancelConnectionTask: id => ipcRenderer.invoke('extension:cancel',id),
  openAccountChrome: id => ipcRenderer.invoke('chrome:openAccount',id),
  prepareExtension: () => ipcRenderer.invoke('extension:setup'),
  copyExtensionsUrl: () => ipcRenderer.invoke('extension:copy'),
  pairExtension: id => ipcRenderer.invoke('extension:pair',id),
  getConnections: () => ipcRenderer.invoke('extension:connections'),
  revokeConnection: id => ipcRenderer.invoke('extension:revoke',id),
  getInitialData: () => ipcRenderer.invoke("app:getInitialData"),
  openChromeInstallAndQuit: () => ipcRenderer.invoke("chrome:installAndQuit"),
  refreshCodexUsage: () => ipcRenderer.invoke("codex:refreshUsage"),
  getCodexModels: () => ipcRenderer.invoke('codex:models'),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  saveAccountStore: (store) => ipcRenderer.invoke("accounts:save", store),
  chooseAccountSampleImage: (accountId) => ipcRenderer.invoke("accounts:chooseSampleImage", accountId),
  deleteAccountSampleImage: (accountId) => ipcRenderer.invoke("accounts:deleteSampleImage", accountId),
  checkAccountSession: (accountId, options) => ipcRenderer.invoke("accounts:checkSession", accountId, options),
  checkAllSessions: () => ipcRenderer.invoke('accounts:checkAllSessions'),
  checkTistorySession: (tistoryBlogId) => ipcRenderer.invoke("tistory:checkSession", tistoryBlogId),
  testTistoryPublish: (form) => ipcRenderer.invoke("tistory:testPublish", form),
  retryHistory: (id,form) => ipcRenderer.invoke('history:retry',{id,form}),
  loadHistory: () => ipcRenderer.invoke("history:load"),
  getPendingPublishState: () => ipcRenderer.invoke('job:pendingState'),
  cancelPendingPublish: () => ipcRenderer.invoke('job:cancelPending'),
  startJob: (form) => ipcRenderer.invoke("job:start", form),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  showFileInFolder: (filePath) => ipcRenderer.invoke("file:showInFolder", filePath),
  respondModelError: choice=>ipcRenderer.invoke('job:modelRetry',choice),
  onModelError: handler=>ipcRenderer.on('job:modelError',(_event,payload)=>handler(payload)),
  onLog: (handler) => {
    ipcRenderer.on("job:log", (_event, payload) => handler(payload));
  },
  onStatus: (handler) => {
    ipcRenderer.on("job:status", (_event, payload) => handler(payload));
  },
  onTokens: (handler) => {
    ipcRenderer.on("job:tokens", (_event, payload) => handler(payload));
  },
  onPreview: (handler) => {
    ipcRenderer.on("job:preview", (_event, payload) => handler(payload));
  },
  onSelectedTitle: (handler) => {
    ipcRenderer.on("job:selectedTitle", (_event, payload) => handler(payload));
  },
  onComplete: (handler) => {
    ipcRenderer.on("job:complete", (_event, payload) => handler(payload));
  },
  onAccountsUpdate: (handler) => {
    ipcRenderer.on("accounts:update", (_event, payload) => handler(payload));
  }
});
