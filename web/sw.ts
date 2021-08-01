/// <reference no-default-lib="true"/>
/// <reference lib="es2018" />
/// <reference lib="webworker" />

// Workaround to tell TypeScript about the correct type of a ServiceWorker.
const sw = self as ServiceWorkerGlobalScope & typeof globalThis;

// There can be multiple clients (pages) receiving files, so they generate an id
// and here we store info assosiated with each transfer.
const streams = new Map();

class Stream {
	name: string;
	size: number;
	filetype: string;
	offset = 0;
	controller?: ReadableStreamDefaultController;
	stream: ReadableStream;

	constructor(name: string, size: number, filetype: string) {
		this.name = name;
		this.size = size;
		this.filetype = filetype;
		this.stream = new ReadableStream(this);
	}

	start(controller: ReadableStreamDefaultController) {
		this.controller = controller;
	}

	cancel(reason: string) {
		console.warn("stream cancelled", reason);
	}
}

function waitForMetadata(id: string) {
	return new Promise((resolve, reject) => {
		streams.set(id, { resolve, reject });
	});
}

function signalMetadataReady(id: string, s: Stream) {
	if (streams.has(id)) {
		streams.get(id).resolve(s);
	}
}

sw.addEventListener("message", (e) => {
	const msg = e.data;
	const id = msg.id;

	switch (msg.type) {
		case "metadata": {
			const s = new Stream(msg.name, msg.size, msg.filetype);

			// Resolve promise if GET request arrived first.
			signalMetadataReady(id, s);

			streams.set(id, s);
			return;
		}
		case "data": {
			const s = streams.get(id);

			if (msg.offset !== s.offset) {
				console.warn(`aborting ${id}: got data out of order`);
				// TODO abort fetch response
				streams.delete(id);
				return;
			}
			s.controller.enqueue(new Uint8Array(msg.data));
			s.offset += msg.data.byteLength;

			return;
		}
		case "end": {
			const s = streams.get(id);

			s.controller.close();

			// Synchronize with fetch handler to clean up properly.
			if (s.requestHandled) {
				streams.delete(id);
			} else {
				s.streamHandled = true;
			}

			return;
		}
		case "error": {
			streams.get(id).controller.error(msg.error);
			return;
		}
	}
});

function encodeFilename(filename: string) {
	return encodeURIComponent(filename)
		.replace(/'/g, "%27")
		.replace(/\(/g, "%28")
		.replace(/\(/g, "%29")
		.replace(/\*/g, "%2A");
}

async function streamDownload(id: string) {
	// Request may arrive before metadata.
	const s = streams.get(id) || (await waitForMetadata(id));

	// Synchronize with message handler end to clean up properly.
	if (s.streamHandled) {
		streams.delete(id);
	} else {
		s.requestHandled = true;
	}

	const { size, name, filetype, stream } = s;

	console.log(`downloading ${name} (${id})`);

	return new Response(stream, {
		headers: {
			"Content-Type": filetype,
			"Content-Length": size,
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(
				name
			)}`,
		},
	});
}

async function streamUpload(e: FetchEvent) {
	const contentLength = e.request.headers.get("content-length");
	const contentType = e.request.headers.get("content-type");
	const form = await e.request.formData();
	const title = form.get("title");

	if (!title) {
		e.respondWith(new Response("no title", { status: 500 }));
		return
	}

	let body: ReadableStream<Uint8Array>;
	if (e.request.body) {
		body = e.request.body;
	} else {
		e.respondWith(new Response("no body", { status: 500 }));
		return
	}

	console.log(`uploading ${title}`);

	e.respondWith(Response.redirect("/", 303)); // get index.html?

	const client = await sw.clients.get(e.clientId || e.resultingClientId);
	if (!client) {
		e.respondWith(new Response("no client", { status: 500 }));
		return
	}

	// ReadableStream is transferable on Chrome at the time of writing. Since Share
	// Target also only works on Chome, we can use this and avoid the complexity of
	// chunking over postMessage (like we do with downloads) or having to read the
	// whole file into memory.
	// TypeScript doesn't know that ReadableStream is transferable, hence body as
	// any.
	client.postMessage(
		{
			name: title,
			size: contentLength,
			type: contentType,
			stream: body,
		},
		[body as any]
	);
}

sw.addEventListener("fetch", (e) => {
	const PREFIX = "/_";
	const url = new URL(e.request.url);

	// Stream download from WebRTC DataChannel.
	if (url.pathname.startsWith(`${PREFIX}/`) && e.request.method === "GET") {
		const id = url.pathname.substring(`${PREFIX}/`.length);
		e.respondWith(streamDownload(id));
		return;
	}

	// Stream upload to WebRTC DataChannel, triggered by Share Target API.
	if (url.pathname.startsWith(`${PREFIX}/`) && e.request.method === "POST") {
		streamUpload(e);
		return;
	}

	// Default to passthrough.
	e.respondWith(fetch(e.request));
});
