"use strict";

const PREFIX = "/_";

// There can be multiple clients (pages) receiving files, so they generate an id
// and here we store info assosiated with each transfer.
const streams = new Map();

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

self.addEventListener("message", (e) => {
	const message = e.data;
	const id = message.id;

	if (message.type === "metadata") {
		const {name, size, filetype} = message;

		const streamInfo = {
			name,
			size,
			filetype,
			offset: 0
		};

		streamInfo.stream = new ReadableStream({
			start(controller) { streamInfo.controller = controller; },
			cancel(reason) { console.warn("stream cancelled", cancelReason); },
		});

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
});

function encodeFilename(filename) {
	return encodeURIComponent(filename)
		.replace(/'/g, "%27")
		.replace(/\(/g, "%28")
		.replace(/\(/g,"%29")
		.replace(/\*/g, "%2A");
}

async function streamDownload(id) {
	// Request may arrive before metadata.
	const streamInfo = streams.get(id) || (await waitForMetadata(id));

	// Synchronize with message handler end to clean up properly.
	if (streamInfo.streamHandled) {
		streams.delete(id);
	} else {
		streamInfo.requestHandled = true;
	}

	const {size, name, filetype, stream} = streamInfo;

	console.log(`downloading ${name} (${id})`);

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
}

async function streamUpload(e) {
	if (!e.clientId) {
		return new Response("no client id", {"status": 500});
	}
	const client = await clients.get(e.clientId);

	if (!client) {
		return new Response("no client", {"status": 500});
	}

	const contentLength = e.request.headers.get("content-length");
	const contentType = e.request.headers.get("content-type");
	const form = await e.request.formData();
	const title = form.get('title')

	if (!title) {
		return new Response("no title", {"status": 500});
	}

	console.log(`uploading ${title}`);

	client.postMessage(
		{
			name: title,
			size: contentLength,
			type: contentType,
			stream: e.request.body
		},
		[e.request.body],
	);

	// TODO wait for confirmation that file was successfully sent before
	// responding?
	return new Response("ok");
}

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);

	// Stream download from WebRTC DataChannel.
	if (url.pathname.startsWith(`${PREFIX}/`) && e.request.method === "GET") {
		const id = url.pathname.substring(`${PREFIX}/`.length);
		e.respondWith(streamDownload(id));
		return;
	}

	// Stream upload to WebRTC DataChannel, triggered by Share Target API.
	if (url.pathname.startsWith(`${PREFIX}/`) && e.request.method === "POST") {
		e.respondWith(streamUpload(e));
		return;
	}

	// Default to passthrough.
	e.respondWith(fetch(e.request));
});
