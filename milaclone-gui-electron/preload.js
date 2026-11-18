"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("mila", {
  api: (method, args) => ipcRenderer.invoke("api", method, args),
  openExternal: url => ipcRenderer.invoke("openExternal", url),
  openPath: src => ipcRenderer.invoke("openPath", src),
  fetchMeta: url => ipcRenderer.invoke("fetchMeta", url),
  uploadFiles: filePaths => ipcRenderer.invoke("uploadFiles", filePaths),
  getPathForFile: f => webUtils.getPathForFile(f),
  vaultList: () => ipcRenderer.invoke("vaultList"),
  vaultCurrent: () => ipcRenderer.invoke("vaultCurrent"),
  vaultCreate: name => ipcRenderer.invoke("vaultCreate", name),
  vaultOpen: id => ipcRenderer.invoke("vaultOpen", id),
  vaultRename: opts => ipcRenderer.invoke("vaultRename", opts),
  vaultReveal: id => ipcRenderer.invoke("vaultReveal", id),
});
