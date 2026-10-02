"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omnirush", {
  state: () => ipcRenderer.invoke("app:state"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  startServer: () => ipcRenderer.invoke("server:start"),
  stopServer: () => ipcRenderer.invoke("server:stop"),
  detectRunners: () => ipcRenderer.invoke("runner:detect"),
  testRunner: (prompt) => ipcRenderer.invoke("runner:test", prompt),
  rtkStatus: (opts) => ipcRenderer.invoke("rtk:status", opts),
  rtkEnable: (opts) => ipcRenderer.invoke("rtk:enable", opts),
  rtkDisable: (opts) => ipcRenderer.invoke("rtk:disable", opts),
  rtkInstall: (opts) => ipcRenderer.invoke("rtk:install", opts),
  rtkGain: (opts) => ipcRenderer.invoke("rtk:gain", opts),
  repairWsl: () => ipcRenderer.invoke("wsl:repair"),
  listLogs: () => ipcRenderer.invoke("logs:list"),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  onServerState: (fn) => {
    const handler = (_event, status) => fn(status);
    ipcRenderer.on("server:state", handler);
    return () => ipcRenderer.off("server:state", handler);
  },
  onLogEntry: (fn) => {
    const handler = (_event, entry) => fn(entry);
    ipcRenderer.on("logs:entry", handler);
    return () => ipcRenderer.off("logs:entry", handler);
  },
});
