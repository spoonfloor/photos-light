const { app, BrowserWindow, Menu, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

const HOST = "127.0.0.1";
const PORT = 5001;
const APP_URL = `http://${HOST}:${PORT}`;

/** @type {import('child_process').ChildProcess | null} */
let backendProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let isQuitting = false;
let ownsBackend = false;
let bootstrapPromise = null;
/** @type {string[]} */
let backendLogs = [];

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function repoRoot() {
  return path.join(__dirname, "..");
}

function backendLaunchConfig() {
  const env = {
    ...process.env,
    PHOTOS_LIGHT_ELECTRON: "1",
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
  };

  if (!app.isPackaged) {
    return {
      command: "python3",
      args: [path.join(repoRoot(), "launcher.py")],
      cwd: repoRoot(),
      env,
    };
  }

  const backendDir = path.join(process.resourcesPath, "backend");
  return {
    command: path.join(backendDir, "photos-light-server"),
    args: [],
    cwd: backendDir,
    env,
  };
}

function isServerReachable(timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT }, () => {
      socket.end();
      resolve(true);
    });

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function waitForServer(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tryConnect = () => {
      const socket = net.createConnection({ host: HOST, port: PORT }, () => {
        socket.end();
        resolve();
      });

      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Photos Light server did not start on ${APP_URL}`));
          return;
        }
        setTimeout(tryConnect, 200);
      });
    };

    tryConnect();
  });
}

function stopBackend() {
  if (!backendProcess || !ownsBackend) {
    backendProcess = null;
    ownsBackend = false;
    return;
  }

  const proc = backendProcess;
  backendProcess = null;
  ownsBackend = false;
  proc.kill("SIGTERM");

  setTimeout(() => {
    if (!proc.killed) {
      proc.kill("SIGKILL");
    }
  }, 2000);
}

async function ensureBackend() {
  if (await isServerReachable()) {
    ownsBackend = false;
    return;
  }

  const { command, args, cwd, env } = backendLaunchConfig();
  backendLogs = [];

  backendProcess = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownsBackend = true;

  backendProcess.stdout?.on("data", (chunk) => {
    backendLogs.push(String(chunk));
    if (backendLogs.length > 40) {
      backendLogs.shift();
    }
  });

  backendProcess.stderr?.on("data", (chunk) => {
    backendLogs.push(String(chunk));
    if (backendLogs.length > 40) {
      backendLogs.shift();
    }
  });

  backendProcess.on("error", (error) => {
    dialog.showErrorBox(
      "Photos Light",
      `Could not start the backend server:\n\n${error.message}`,
    );
    app.quit();
  });

  backendProcess.on("exit", async (code, signal) => {
    backendProcess = null;
    ownsBackend = false;

    if (isQuitting || !code) {
      return;
    }

    if (await isServerReachable()) {
      // Port was already in use but another server is responding — keep going.
      return;
    }

    const details = backendLogs.join("").trim();
    const suffix = details ? `\n\n${details.slice(-1200)}` : "";
    dialog.showErrorBox(
      "Photos Light",
      `The backend server exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ""}).${suffix}`,
    );
    app.quit();
  });
}

function createWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "Photos Light",
    backgroundColor: "#121212",
    show: false,
    fullscreen: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: "Photos Light",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootstrapOnce() {
  buildMenu();
  await ensureBackend();

  try {
    await waitForServer();
  } catch (error) {
    dialog.showErrorBox("Photos Light", error.message);
    stopBackend();
    app.quit();
    return;
  }

  createWindow();
}

function bootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapOnce().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

app.whenReady().then(bootstrap);

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  } else {
    bootstrap();
  }
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  bootstrap();
});
