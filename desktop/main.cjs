const path = require("node:path");
const { app, BrowserWindow, dialog, shell, session } = require("electron");

const PARTITION = "persist:veil-browser";
const SAFE_PROTOCOLS = new Set(["http:", "https:"]);
let mainWindow;
const permissionDecisions = new Map();
const permissionLabels = new Map([
  ["media", "use your microphone or camera"],
  ["geolocation", "access your location"],
  ["notifications", "send notifications"],
]);

function isWebUrl(value) {
  try {
    return SAFE_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    params.partition = PARTITION;
  });

  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) {
        mainWindow?.webContents.send("veil:navigate", url);
      }
      return { action: "deny" };
    });

    guest.on("will-navigate", (event, url) => {
      if (isWebUrl(url) || url === "about:blank") return;
      event.preventDefault();
      if (/^(?:mailto|tel):/i.test(url)) {
        shell.openExternal(url).catch((error) => {
          console.error("Could not open external link:", error.message);
        });
      }
    });

    guest.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const shortcut = input.control || input.meta;
      if (shortcut && input.key.toLowerCase() === "l") {
        event.preventDefault();
        mainWindow?.webContents.send("veil:focus-address");
      } else if (shortcut && input.key.toLowerCase() === "r") {
        event.preventDefault();
        guest.reload();
      }
    });
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if ((input.control || input.meta) && input.key.toLowerCase() === "l") {
      event.preventDefault();
      mainWindow?.webContents.send("veil:focus-address");
    }
  });

  const browserSession = session.fromPartition(PARTITION);
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const label = permissionLabels.get(permission);
    if (!label) {
      callback(false);
      return;
    }

    let origin;
    try {
      origin = new URL(details.requestingUrl || webContents.getURL()).origin;
    } catch {
      callback(false);
      return;
    }
    const key = `${origin}:${permission}`;
    if (permissionDecisions.has(key)) {
      callback(permissionDecisions.get(key));
      return;
    }

    const hostname = new URL(origin).hostname;
    dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Website permission",
      message: `Allow ${hostname} to ${label}?`,
      detail: "Only allow permissions for sites you trust.",
      buttons: ["Block", "Allow"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      const allowed = response === 1;
      permissionDecisions.set(key, allowed);
      callback(allowed);
    }).catch((error) => {
      console.error("Could not show website permission prompt:", error.message);
      callback(false);
    });
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
