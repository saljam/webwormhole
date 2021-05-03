"use strict";
const PREFIX = "/_";

// There can be multiple clients (pages) receiving files, so they generate an id
// and here we store info assosiated with each transfer.
const streams = new Map();

// Repurposing the map...
function waitForMetadata(id) {
	return new Promise((resolve, reject) => {
		streams.set(id, {resolve, reject});
	});
}
function signalMetadataReady(id, streamInfo) {
	if (streams.has(id)) {
		streams.get(id).resolve(streamInfo);
	}
}

function createStream(onCancel) {
	const streamInfo = {};

	streamInfo.stream = new ReadableStream({
		start(controller) {
			streamInfo.controller = controller;
		},
		cancel(reason) {
			onCancel(reason);
		},
	});

	return streamInfo;
}

self.addEventListener(
	"message",
	(event) => {
		const message = event.data;
		const id = message.id;

		if (message.type === "metadata") {
			const {name, size, filetype} = message;

			// TODO propagate cancellation back to main window and sender.
			function onCancel(cancelReason) {
				return console.warn("stream cancelled", cancelReason);
			}
			const streamInfo = {
				name,
				size,
				filetype,
				offset: 0,
				...createStream(onCancel),
			};

			// Resolve promise if GET request arrived first.
			signalMetadataReady(id, streamInfo);

			streams.set(id, streamInfo);
		} else {
			const streamInfo = streams.get(id);

			if (message.type === "data") {
				if (message.offset !== streamInfo.offset) {
					console.warn(`aborting ${id}: got data out of order`);
					// TODO abort fetch response
					streams.delete(id);
					return;
				}
				streamInfo.controller.enqueue(new Uint8Array(message.data));
				streamInfo.offset += message.data.byteLength;
			} else if (message.type === "end") {
				streamInfo.controller.close();

				// Synchronize with fetch handler to clean up properly.
				if (streamInfo.requestHandled) {
					streams.delete(id);
				} else {
					streamInfo.streamHandled = true;
				}
			} else if (message.type === "error") {
				streamInfo.controller.error(message.error);
			}
		}
	},
);

function encodeFilename(filename) {
	return encodeURIComponent(filename).replace(/'/g, "%27").replace(/\(/g, "%28").replace(
		/\(/g,
		"%29",
	).replace(/\*/g, "%2A");
}

self.addEventListener(
	"fetch",
	(event) => {
		const url = new URL(event.request.url);

		// Sanity test.
		if (event.request.method !== "GET" || !url.pathname.startsWith(`${PREFIX}/`)) {
			event.respondWith(fetch(event.request));
			return;
		}

		event.respondWith(
			(async () => {
				const id = url.pathname.substring(`${PREFIX}/`.length);

				// Request may arrive before metadata.
				const streamInfo = streams.get(id) || (await waitForMetadata(id));

				// Synchronize with message handler end to clean up properly.
				if (streamInfo.streamHandled) {
					streams.delete(id);
				} else {
					streamInfo.requestHandled = true;
				}

				const {size, name, filetype, stream} = streamInfo;

				console.log(`serving ${name} (${id})`);

				// Thanks to https://github.com/jimmywarting/StreamSaver.js for proper headers.
				return new Response(
					stream,
					{
						headers: {
							"Content-Type": filetype,
							"Content-Length": size,
							"Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(
								name,
							)}`,
						},
					},
				);
			})(),
		);
	},
);
