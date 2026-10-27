async function onExportButtonClick() {
	const reportName = document.querySelector("#report-name")?.value ?? "weekly";
	const result = await window.acmeDesktop.exportDiagnostics({
		reportName,
		compressWithTar: true,
	});
	return result.savedTo;
}

async function onActivateLicenseClick(serialKey) {
	return window.acmeDesktop.verifyLicense(serialKey);
}

export { onActivateLicenseClick, onExportButtonClick };
