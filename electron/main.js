const { app, BrowserWindow, Menu, dialog } = require("electron");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const net = require("net");

const HOST = "127.0.0.1";
const PORT = 5001;
const APP_URL = `http://${HOST}:${PORT}`;
const LIBRARY_STATUS_URL = `${APP_URL}/api/library/status`;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getListeningPids(port) {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim();
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function getProcessCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function isOurBackendCommand(command) {
  if (!command) {
    return false;
  }

  if (command.includes("photos-light-server")) {
    return true;
  }

  if (!/python/i.test(command)) {
    return false;
  }

  const root = repoRoot();
  if (!command.includes(root)) {
    return false;
  }

  return command.includes("launcher.py") || command.includes("app.py");
}

async function killProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Process may already be gone.
  }
}

async function stopOurBackendOnPort(port) {
  for (const pid of getListeningPids(port)) {
    if (pid === process.pid) {
      continue;
    }

    const command = getProcessCommand(pid);
    if (!isOurBackendCommand(command)) {
      continue;
    }

    await killProcess(pid, "SIGTERM");
  }

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const remaining = getListeningPids(port).filter((pid) => {
      if (pid === process.pid) {
        return false;
      }
      return isOurBackendCommand(getProcessCommand(pid));
    });

    if (remaining.length === 0) {
      return;
    }

    if (Date.now() + 1500 >= deadline) {
      for (const pid of remaining) {
        await killProcess(pid, "SIGKILL");
      }
    }

    await sleep(100);
  }
}

async function assertPortAvailableForLaunch() {
  await stopOurBackendOnPort(PORT);

  const foreignPids = getListeningPids(PORT).filter((pid) => {
    if (pid === process.pid) {
      return false;
    }
    return !isOurBackendCommand(getProcessCommand(pid));
  });

  if (foreignPids.length > 0) {
    const foreignCommand = getProcessCommand(foreignPids[0]) || "unknown process";
    throw new Error(
      `Port ${PORT} is already in use by another application:\n\n${foreignCommand}\n\nQuit that process and try again.`,
    );
  }

  if (await isServerReachable()) {
    throw new Error(`Port ${PORT} is still in use. Quit the other process and try again.`);
  }
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

async function waitForEmptyLibrarySession(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(LIBRARY_STATUS_URL);
      const payload = await response.json();
      lastStatus = payload?.status || null;

      if (payload?.status === "not_configured") {
        return;
      }

      if (payload?.status === "healthy") {
        throw new Error(
          "Photos Light started with a library already loaded. This usually means an old backend was reused.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("already loaded")) {
        throw error;
      }
    }

    await sleep(200);
  }

  throw new Error(
    lastStatus
      ? `Photos Light did not reach the welcome state (last status: ${lastStatus}).`
      : "Photos Light did not reach the welcome state.",
  );
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

function attachBackendProcessHandlers(proc) {
  proc.stdout?.on("data", (chunk) => {
    backendLogs.push(String(chunk));
    if (backendLogs.length > 40) {
      backendLogs.shift();
    }
  });

  proc.stderr?.on("data", (chunk) => {
    backendLogs.push(String(chunk));
    if (backendLogs.length > 40) {
      backendLogs.shift();
    }
  });

  proc.on("error", (error) => {
    dialog.showErrorBox(
      "Photos Light",
      `Could not start the backend server:\n\n${error.message}`,
    );
    app.quit();
  });

  proc.on("exit", (code, signal) => {
    if (backendProcess === proc) {
      backendProcess = null;
      ownsBackend = false;
    }

    if (isQuitting || !code) {
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

function spawnOwnedBackend() {
  const { command, args, cwd, env } = backendLaunchConfig();
  backendLogs = [];

  backendProcess = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownsBackend = true;
  attachBackendProcessHandlers(backendProcess);
}

async function ensureBackend() {
  if (backendProcess && ownsBackend && (await isServerReachable())) {
    return;
  }

  await assertPortAvailableForLaunch();
  spawnOwnedBackend();
}

function createWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 560,
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

  try {
    await ensureBackend();
    await waitForServer();
    await waitForEmptyLibrarySession();
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
