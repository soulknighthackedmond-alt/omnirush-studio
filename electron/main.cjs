"use strict";

const path = require("node:path");
const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");

const configStore = require("./config.cjs");
const logs = require("./log.cjs");
const runner = require("./runner.cjs");
const rtk = require("./rtk.cjs");
const wsl = require("./wsl.cjs");
const { ApiServer } = require("./openai-server.cjs");
const { runPrompt } = require("./session.cjs");

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "";
const log = logs.log;

let current = configStore.load();
let mainWindow = null;

const api = new ApiServer({
  getConfig: () => current,
  onStateChange: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("server:state", status);
  },
});

logs.subscribe((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("logs:entry", entry);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    title: "OmniRush Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function state() {
  return {
    config: current,
    paths: { config: configStore.configPath(), appDir: configStore.configDir() },
    models: configStore.KNOWN_MODELS,
    thinkingLevels: configStore.THINKING_LEVELS,
    server: api.status(),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    },
  };
}

function registerIpc() {
  ipcMain.handle("app:state", () => state());

  ipcMain.handle("config:save", (_event, patch) => {
    current = configStore.save({ ...current, ...patch });
    api.semaphore.setLimit(current.maxConcurrency || 2);
    log.info("app", "settings saved");
    return state();
  });

  ipcMain.handle("server:start", async () => {
    try {
      await api.start();
      return { ok: true, state: state() };
    } catch (err) {
      log.error("api", `could not start: ${err.message}`);
      return { ok: false, error: err.message, state: state() };
    }
  });

  ipcMain.handle("server:stop", async () => {
    await api.stop();
    return { ok: true, state: state() };
  });

  ipcMain.handle("runner:detect", async () => {
    const results = await runner.detect(current, { force: true });
    return results.map(({ launch, ...rest }) => ({ ...rest, launch: launch ? launch.display : null }));
  });

  ipcMain.handle("runner:test", async (_event, promptText) => {
    const resolved = await runner.resolveRunner(current);
    if (!resolved.ok) return { ok: false, error: resolved.error, runner: null };
    const version = await runner.versionThrough(current, resolved.mode);
    const prompt = (promptText || "").trim() || "Reply with exactly: OK";
    log.info("test", `probe via ${resolved.launch.display}`);
    const result = await runPrompt({
      launch: resolved.launch,
      prompt,
      timeoutMs: Math.min(120, Number(current.requestTimeout) || 120) * 1000,
    });
    return {
      ok: !result.error,
      runner: resolved.launch.display,
      mode: resolved.mode,
      version,
      text: result.text,
      error: result.error,
      durationMs: result.durationMs,
      usage: result.usage,
    };
  });

  // --- RTK compression -------------------------------------------------
  ipcMain.handle("rtk:status", async (_event, opts) => rtk.status(current, opts || {}));

  ipcMain.handle("rtk:enable", async (_event, opts) => {
    log.info("rtk", "enabling RTK compression for the agent");
    const result = await rtk.enable(current, opts || {});
    if (result.ok) {
      const where = result.status.dirs.filter((dir) => dir.files.length).map((dir) => dir.path);
      log.success("rtk", `RTK compression enabled in ${result.status.label}${result.copied.length ? ` (mirrored ${result.copied.length} file(s))` : ""}`);
      for (const dir of where) log.info("rtk", `hook: ${dir}`);
    } else {
      log.error("rtk", `enable failed: ${result.error}`);
    }
    return result;
  });

  ipcMain.handle("rtk:disable", async (_event, opts) => {
    const result = await rtk.disable(current, opts || {});
    if (result.ok) log.warn("rtk", `RTK compression disabled (${result.moved.length} file(s) renamed to .bak)`);
    else log.info("rtk", result.error);
    return result;
  });

  ipcMain.handle("rtk:install", async (_event, opts) => {
    const result = await rtk.install(current, opts || {});
    if (result.ok) log.success("rtk", `RTK installed in ${result.status.label}: ${result.status.cli.version || "ok"}`);
    else log.error("rtk", `install failed: ${result.error}`);
    return result;
  });

  ipcMain.handle("rtk:gain", async (_event, opts) => {
    const result = await rtk.gain(current, opts || {});
    if (!result.ok) log.warn("rtk", `rtk gain: ${result.error}`);
    return result;
  });

  ipcMain.handle("wsl:repair", async () => {
    log.info("wsl", "repairing WSL (wsl --update, wsl --shutdown)");
    const result = await wsl.repair(current.wslDistro);
    if (result.ok) log.success("wsl", `${result.distro} answers again`);
    else log.error("wsl", result.detail);
    return result;
  });

  ipcMain.handle("logs:list", () => logs.list());
  ipcMain.handle("logs:clear", () => {
    logs.clear();
    return [];
  });

  ipcMain.handle("shell:openExternal", (_event, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  if (current.autoStart) {
    try {
      await api.start();
    } catch (err) {
      log.error("api", `auto-start failed: ${err.message}`);
    }
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", async () => {
  await api.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await api.stop();
});
