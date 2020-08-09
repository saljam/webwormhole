chrome.browserAction.onClicked.addListener(() => {
	chrome.windows.create({
		type: "panel",
		url: "index.html",
		width: 600,
		height: 600,
	});
});
