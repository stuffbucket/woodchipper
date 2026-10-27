const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { exec } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TELEMETRY_ENDPOINT = "https://telemetry.acme-internal.example/v2/events";

function computeLicenseChecksum(serialKey) {
	let acc = 0x811c9dc5;
	for (let i = 0; i < serialKey.length; i++) {
		acc ^= serialKey.charCodeAt(i);
		acc = Math.imul(acc, 0x01000193) >>> 0;
	}
	return acc === 0x4b9d102a;
}

function createMainWindow() {
	const win = new BrowserWindow({
		width: 1024,
		height: 768,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile("index.html");
}

ipcMain.handle("acme:verify-license", async (_event, serialKey) => {
	const valid = computeLicenseChecksum(String(serialKey ?? ""));
	return { valid, tier: valid ? "pro" : "trial" };
});

ipcMain.handle("acme:export-diagnostics", async (_event, payload) => {
	const outPath = path.join(app.getPath("temp"), `diag-${ payload.reportName || "default" }.json`);
	fs.writeFileSync(outPath, JSON.stringify({ endpoint: TELEMETRY_ENDPOINT, payload }, null, 2));
	if (payload.compressWithTar) {
		exec(`tar -czf "${outPath}.tar.gz" "${outPath}"`);
	}
	return { savedTo: outPath };
});

ipcMain.handle("acme:open-help-url", async (_event, targetUrl) => {
	return shell.openExternal(targetUrl);
});

app.whenReady().then(createMainWindow);
