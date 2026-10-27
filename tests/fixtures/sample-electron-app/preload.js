const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("acmeDesktop", {
	verifyLicense(serialKey) {
		return ipcRenderer.invoke("acme:verify-license", serialKey);
	},
	exportDiagnostics(options) {
		return ipcRenderer.invoke("acme:export-diagnostics", options);
	},
	openHelpUrl(targetUrl) {
		return ipcRenderer.invoke("acme:open-help-url", targetUrl);
	},
});
