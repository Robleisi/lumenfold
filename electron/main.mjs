import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { startRelay, stopRelay, getRelayInfo, isRelayRunning } from "../server/relay.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Awaited<ReturnType<typeof startRelay>> | null} */
let relayInfo = null;

function appRoot() {
  return app.isPackaged ? app.getAppPath() : join(__dirname, "..");
}

async function ensureRelay() {
  if (isRelayRunning() && relayInfo) return relayInfo;
  relayInfo = await startRelay({
    serveStatic: true,
    root: appRoot(),
    port: Number(process.env.LUMENFOLD_PORT || 8787),
  });
  return relayInfo;
}

function createWindow(pageUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "折光织界 · Lumenfold",
    backgroundColor: "#1a1814",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(pageUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("relay:ensure", async () => ensureRelay());
ipcMain.handle("relay:info", async () => {
  if (!isRelayRunning()) await ensureRelay();
  return getRelayInfo();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const info = await ensureRelay();
    createWindow(info.page);

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const again = await ensureRelay();
        createWindow(again.page);
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopRelay().catch(() => {});
});
